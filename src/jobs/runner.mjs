import { errMsg, trim } from "../core/redact.mjs";

function now() { return new Date().toISOString(); }

export class JobRunner {
  constructor({ config, store, runtime, onComplete }) {
    this.config = config;
    this.store = store;
    this.runtime = runtime;
    this.onComplete = onComplete;
    this.queue = [];
    this.active = 0;
  }

  enqueue(job) {
    this.queue.push(job.id);
    void this.store.event(job.id, "queue.enqueued", { depth: this.queue.length });
    this.#pump();
  }

  async cancel(jobId) {
    const job = this.store.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.status === "queued") {
      this.queue = this.queue.filter((id) => id !== jobId);
      await this.store.update(jobId, { status: "cancelled", completedAt: now() });
      await this.store.event(jobId, "job.cancelled", {});
    }
    return this.store.get(jobId);
  }

  #pump() {
    while (this.active < this.config.runtime.maxConcurrency && this.queue.length) {
      const jobId = this.queue.shift();
      const job = this.store.get(jobId);
      if (!job || job.status !== "queued") continue;
      this.active++;
      this.#run(job)
        .catch(async (e) => {
          await this.store.update(job.id, { status: "failed", error: errMsg(e), completedAt: now() });
          await this.store.event(job.id, "job.failed", { error: errMsg(e) });
        })
        .finally(() => { this.active--; this.#pump(); });
    }
  }

  async #run(job) {
    await this.store.update(job.id, { status: "running", startedAt: now(), completedAt: null, error: null });
    await this.store.event(job.id, "job.started", { model: job.model, thinkingLevel: job.thinkingLevel });

    const result = await this.runtime.run(job, {
      onEvent: async (type, data) => {
        if (type === "agent.text") {
          await this.store.appendText(job.id, data.text);
          await this.store.event(job.id, type, data);
        } else {
          await this.store.event(job.id, type, data);
        }
      },
    });

    const output = result.text || this.store.get(job.id)?.output || "";
    await this.store.update(job.id, {
      status: "completed",
      result: output,
      completedAt: now(),
      ...(job.piSessionFile ? { piSessionFile: job.piSessionFile } : {}),
      ...(job.piSessionDir ? { piSessionDir: job.piSessionDir } : {}),
      ...(job.figmaArtifactsDir ? { figmaArtifactsDir: job.figmaArtifactsDir } : {}),
      ...(job.jiraArtifactsDir ? { jiraArtifactsDir: job.jiraArtifactsDir } : {}),
    });
    await this.store.event(job.id, "job.completed", { length: output.length });

    if (this.onComplete) await this.onComplete(job, output);
  }
}
