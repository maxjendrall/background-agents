import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { id } from "../core/ids.mjs";
import { redactData } from "../core/redact.mjs";
import { compactEvents, compactEventsAfter } from "../core/events.mjs";

function now() { return new Date().toISOString(); }

export class JobStore {
  constructor(config) {
    this.config = config;
    this.jobs = new Map();
    this.subs = new Map();
  }

  async load() {
    const dir = this.config.paths.jobs;
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = resolve(dir, entry.name, "job.json");
      if (!existsSync(p)) continue;
      const job = JSON.parse(await readFile(p, "utf8"));
      if (job.status === "running" || job.status === "queued") {
        const previousStatus = job.status;
        job.status = "queued";
        job.startedAt = null;
        job.completedAt = null;
        job.error = null;
        if ((job.result || job.output) && !job.resumeStrategy) job.resumeStrategy = "context";
        job.updatedAt = now();
        this.jobs.set(job.id, job);
        await this.#write(job);
        await this.event(job.id, "job.recovered", { from: previousStatus, reason: "server_startup" });
        continue;
      }
      this.jobs.set(job.id, job);
      await this.#write(job);
    }
  }

  async create(input) {
    const jobId = id("job");
    const dir = resolve(this.config.paths.jobs, jobId);
    const ws = resolve(this.config.paths.workspaces, jobId);
    await Promise.all([mkdir(dir, { recursive: true }), mkdir(ws, { recursive: true }), mkdir(resolve(dir, "artifacts"), { recursive: true })]);
    const job = {
      id: jobId, kind: input.kind || "agent", status: "queued",
      title: input.title || input.issueKey || "job",
      issueKey: input.issueKey || null,
      prompt: input.prompt, model: input.model || this.config.runtime.model,
      thinkingLevel: input.thinkingLevel || input.thinking || this.config.runtime.thinkingLevel,
      messageMode: input.messageMode || input.mode || "follow_up",
      body: input.body || {}, autoComment: Boolean(input.autoComment),
      workspacePath: ws, artifactsPath: resolve(dir, "artifacts"),
      createdAt: now(), updatedAt: now(),
    };
    this.jobs.set(jobId, job);
    await this.#write(job);
    await this.event(jobId, "job.created", { kind: job.kind, issueKey: job.issueKey, prompt: (input.prompt || "").slice(0, 50_000), title: job.title, model: job.model });
    return job;
  }

  get(jobId) { return this.jobs.get(jobId) || null; }

  findByIssueKey(issueKey) {
    if (!issueKey) return null;
    // Find the most recent job for this issue key that isn't cancelled
    const candidates = [...this.jobs.values()]
      .filter((j) => j.issueKey === issueKey && j.status !== "cancelled")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return candidates[0] || null;
  }

  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  async update(jobId, patch) {
    const job = this.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    Object.assign(job, patch, { updatedAt: now() });
    await this.#write(job);
    this.#emit(jobId, { type: "job.updated", ts: now(), data: this.pub(job) });
    return job;
  }

  async event(jobId, type, data = {}) {
    const evt = { id: id("evt"), jobId, type, ts: now(), data: redactData(data) };
    await appendFile(resolve(this.config.paths.jobs, jobId, "events.jsonl"), JSON.stringify(evt) + "\n", "utf8");
    this.#emit(jobId, evt);
    return evt;
  }

  async appendText(jobId, text) {
    const job = this.get(jobId);
    if (!job) return;
    job.output = (job.output || "") + text;
    job.updatedAt = now();
  }

  async events(jobId, opts = {}) {
    const p = resolve(this.config.paths.jobs, jobId, "events.jsonl");
    if (!existsSync(p)) return [];
    const raw = (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (opts.raw) return raw;
    if (opts.afterId) return compactEventsAfter(raw, opts.afterId);
    return compactEvents(raw);
  }

  async clearEvents(jobId) {
    const p = resolve(this.config.paths.jobs, jobId, "events.jsonl");
    await writeFile(p, "", "utf8");
  }

  subscribe(jobId, fn) {
    const set = this.subs.get(jobId) || new Set();
    set.add(fn);
    this.subs.set(jobId, set);
    return () => { set.delete(fn); if (!set.size) this.subs.delete(jobId); };
  }

  pub(job, opts = {}) {
    return {
      id: job.id, kind: job.kind, title: job.title, issueKey: job.issueKey,
      status: job.status, model: job.model, thinkingLevel: job.thinkingLevel || null, messageMode: job.messageMode || null,
      createdAt: job.createdAt, startedAt: job.startedAt || null, completedAt: job.completedAt || null,
      result: job.result || null, error: job.error || null,
      hasSession: Boolean(job.piSessionFile || job.piSessionDir),
      ...(opts.events ? { events: opts.events } : {}),
    };
  }

  async #write(job) { await writeFile(resolve(this.config.paths.jobs, job.id, "job.json"), JSON.stringify(job, null, 2) + "\n"); }
  #emit(jobId, evt) { const s = this.subs.get(jobId); if (s) for (const fn of s) fn(evt); }
}
