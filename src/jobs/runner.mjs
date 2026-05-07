import { errMsg } from "../core/redact.mjs";
import { JobEventSink } from "./event-sink.mjs";

function now() { return new Date().toISOString(); }

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
    await this.store.update(job.id, {
      status: "completed",
      result: output,
      completedAt: now(),
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
