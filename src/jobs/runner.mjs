import { errMsg } from "../core/redact.mjs";
import { JobEventSink } from "./event-sink.mjs";
import { resolve } from "node:path";

function now() { return new Date().toISOString(); }

function isRetryableBootError(e) {
  const msg = errMsg(e);
  return /AgentOS VM boot|Pi session boot|boot .*timed out|session .*timed out/i.test(msg);
}

function toolCompleted(events, name) {
  const namesById = new Map();
  for (const e of events) {
    if (e.type !== "agent.tool_acp") continue;
    const d = e.data || {};
    if (d.type === "tool_start" && d.id) namesById.set(d.id, d.name);
    if (d.type === "tool_update" && d.status === "completed" && namesById.get(d.id) === name) return true;
  }
  return false;
}

function latestRunEvents(events) {
  const idx = events.map((e) => e.type).lastIndexOf("job.started");
  return idx >= 0 ? events.slice(idx + 1) : events;
}

function shouldRequireJiraCompletion(job) {
  if (!job?.issueKey) return false;
  const prompt = String(job.prompt || "").toLowerCase();
  return !/self-trigger|own previous ai comment|own prior comments|no new external feedback/.test(prompt);
}

function continuationPrompt(job, attempt, max) {
  return [
    `Continue working on Jira issue ${job.issueKey}.`,
    `Your previous turn ended before completing the required Jira workflow (no final jira_add_comment was recorded).`,
    `Do not restart from scratch; continue from the current workspace and what you already inspected.`,
    `If the ticket is clear, implement the smallest safe change, use native git_commit/git_push and gh_pr_create or gh_pr_comment as appropriate, then add exactly one final jira_add_comment with changes, tests, PR/status, and blockers.`,
    `If it is unclear or blocked, add exactly one final jira_add_comment asking a concrete clarification question and stop.`,
    `Do not add progress or acknowledgement comments before the end of the turn.`,
    `Auto-continuation attempt ${attempt}/${max}.`,
  ].join("\n");
}

export class JobRunner {
  constructor({ config, store, runtime, onComplete }) {
    this.config = config;
    this.store = store;
    this.runtime = runtime;
    this.onComplete = onComplete;
    this.queue = [];
    this.active = 0;
    this.running = new Map();
  }

  enqueue(job) {
    if (!job || job.status === "cancelled") return;
    this.queue.push(job.id);
    void this.store.event(job.id, "queue.enqueued", { depth: this.queue.length });
    this.#pump();
  }

  async cancel(jobId) {
    const job = this.store.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    this.queue = this.queue.filter((id) => id !== jobId);
    if (job.status === "queued") {
      await this.store.update(jobId, { status: "cancelled", completedAt: now() });
      await this.store.event(jobId, "job.cancelled", { reason: "user_cancelled" });
      return this.store.get(jobId);
    }
    if (job.status === "running") {
      const run = this.running.get(jobId);
      if (run) {
        run.cancelled = true;
        // Free the queue slot immediately. The underlying AgentOS promise may
        // resolve/reject later, but it must not block the queue or overwrite the
        // cancelled status when it does.
        if (run.countsActive) {
          run.countsActive = false;
          this.active = Math.max(0, this.active - 1);
        }
      }
      this.runtime.disposeJob(jobId);
      await this.store.update(jobId, { status: "cancelled", completedAt: now(), error: null });
      await this.store.event(jobId, "job.cancelled", { reason: "user_cancelled" });
      this.#pump();
    }
    return this.store.get(jobId);
  }

  #pump() {
    while (this.active < this.config.runtime.maxConcurrency && this.queue.length) {
      const jobId = this.queue.shift();
      const job = this.store.get(jobId);
      if (!job || job.status !== "queued") continue;
      this.active++;
      const run = { cancelled: false, countsActive: true };
      this.running.set(job.id, run);
      this.#run(job, run)
        .catch(async (e) => {
          if (run.cancelled || this.store.get(job.id)?.status === "cancelled") return;
          if (isRetryableBootError(e)) {
            const current = this.store.get(job.id);
            const attempts = (current?.bootRetryCount || 0) + 1;
            const max = this.config.runtime.agentBootRetries || 3;
            if (attempts <= max) {
              await this.store.update(job.id, {
                status: "queued",
                error: null,
                completedAt: null,
                bootRetryCount: attempts,
                ...(current?.workspacePath ? { piSessionDir: resolve(current.workspacePath, `.pi-sessions-retry-${attempts}-${Date.now()}`) } : {}),
              });
              await this.store.event(job.id, "job.requeued", {
                reason: "agent_boot_timeout",
                attempt: attempts,
                max,
                error: errMsg(e),
              });
              this.queue.push(job.id);
              return;
            }
          }
          await this.store.update(job.id, { status: "failed", error: errMsg(e), completedAt: now() });
          await this.store.event(job.id, "job.failed", { error: errMsg(e) });
        })
        .finally(() => {
          this.running.delete(job.id);
          if (run.countsActive) this.active = Math.max(0, this.active - 1);
          this.#pump();
        });
    }
  }

  async #run(job, run) {
    await this.store.update(job.id, { status: "running", startedAt: now(), completedAt: null, error: null });
    await this.store.event(job.id, "job.started", { model: job.model, thinkingLevel: job.thinkingLevel });
    if (run.cancelled || this.store.get(job.id)?.status === "cancelled") {
      this.runtime.disposeJob(job.id);
      return;
    }

    const events = new JobEventSink({ store: this.store, jobId: job.id });
    let result;
    try {
      result = await this.runtime.run(job, {
        onEvent: (type, data) => {
          if (run.cancelled || this.store.get(job.id)?.status === "cancelled") return Promise.resolve();
          return events.event(type, data);
        },
      });
    } finally {
      await events.flush();
    }

    if (run.cancelled || this.store.get(job.id)?.status === "cancelled") {
      this.runtime.disposeJob(job.id);
      return;
    }

    const output = result.text || this.store.get(job.id)?.output || "";
    const rawEvents = await this.store.events(job.id, { raw: true });
    const runEvents = latestRunEvents(rawEvents);
    if (shouldRequireJiraCompletion(job) && !toolCompleted(runEvents, "jira_add_comment")) {
      const current = this.store.get(job.id);
      const attempts = (current?.autoContinueCount || 0) + 1;
      const max = this.config.runtime.agentAutoContinueLimit || 5;
      if (attempts <= max) {
        await this.store.update(job.id, {
          status: "queued",
          prompt: continuationPrompt(job, attempts, max),
          error: null,
          completedAt: null,
          autoContinueCount: attempts,
        });
        await this.store.event(job.id, "job.auto_continue", {
          reason: "missing_final_jira_comment",
          attempt: attempts,
          max,
        });
        this.queue.push(job.id);
        return;
      }
      await this.store.update(job.id, {
        status: "failed",
        error: `Jira job ended ${max} times without final jira_add_comment`,
        completedAt: now(),
      });
      await this.store.event(job.id, "job.failed", { error: `Missing final jira_add_comment after ${max} continuations` });
      return;
    }

    await this.store.update(job.id, {
      status: "completed",
      result: output,
      completedAt: now(),
      bootRetryCount: 0,
      autoContinueCount: 0,
      ...(job.piSessionFile ? { piSessionFile: job.piSessionFile } : {}),
      ...(job.piSessionDir ? { piSessionDir: job.piSessionDir } : {}),
      ...(job.figmaArtifactsDir ? { figmaArtifactsDir: job.figmaArtifactsDir } : {}),
      ...(job.jiraArtifactsDir ? { jiraArtifactsDir: job.jiraArtifactsDir } : {}),
      ...(job.contentfulArtifactsDir ? { contentfulArtifactsDir: job.contentfulArtifactsDir } : {}),
    });
    await this.store.event(job.id, "job.completed", { length: output.length });

    if (this.onComplete) await this.onComplete(job, output);
  }
}
