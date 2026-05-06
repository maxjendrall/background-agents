import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { registerRoutes, extensionList } from "../core/extension.mjs";
import { auth } from "./auth.mjs";

export function createApp({ config, store, runner, extensions }) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("config", config); await next(); });
  app.use("*", cors());

  // --- UI ---
  const uiDir = resolve(config.root, "ui");
  app.get("/ui", (c) => c.html(readFileSync(resolve(uiDir, "index.html"), "utf8")));
  app.get("/ui/app.js", (c) => { c.header("content-type", "application/javascript"); return c.body(readFileSync(resolve(uiDir, "app.js"), "utf8")); });
  app.get("/ui/style.css", (c) => { c.header("content-type", "text/css"); return c.body(readFileSync(resolve(uiDir, "style.css"), "utf8")); });

  // --- Public ---
  app.get("/", (c) => c.json({ name: "background-agents", extensions: extensionList(extensions) }));
  app.get("/health", (c) => c.json({
    ok: true,
    workspace: config.workspace.exists ? config.workspace.path : null,
    model: config.runtime.model,
    concurrency: config.runtime.maxConcurrency,
    queue: runner.queue.length,
    active: runner.active,
    jobs: store.list().length,
    extensions: extensionList(extensions),
  }));

  // --- Protected ---
  app.use("/api/*", auth);

  // Config
  app.get("/api/config", (c) => c.json({
    model: config.runtime.model,
    concurrency: config.runtime.maxConcurrency,
    workspace: config.workspace.exists ? config.workspace.path : null,
    extensions: extensionList(extensions),
  }));

  app.put("/api/config/model", async (c) => {
    const { model } = await c.req.json();
    if (!model || typeof model !== "string") return c.json({ error: "model required" }, 400);
    config.runtime.model = model;
    return c.json({ model: config.runtime.model });
  });

  // Jobs
  app.get("/api/jobs", (c) => c.json({ jobs: store.list().map((j) => store.pub(j)) }));

  app.get("/api/jobs/:id", async (c) => {
    const job = store.get(c.req.param("id"));
    if (!job) return c.json({ error: "Not found" }, 404);
    const evts = c.req.query("events") === "1" ? await store.events(job.id) : undefined;
    return c.json({ job: store.pub(job, { events: evts }) });
  });

  app.get("/api/jobs/:id/events", async (c) => {
    const job = store.get(c.req.param("id"));
    if (!job) return c.json({ error: "Not found" }, 404);
    const initial = await store.events(job.id);
    return streamSSE(c, async (stream) => {
      for (const evt of initial) await stream.writeSSE({ data: JSON.stringify(evt), event: evt.type, id: evt.id });
      const unsub = store.subscribe(job.id, (evt) => { void stream.writeSSE({ data: JSON.stringify(evt), event: evt.type, id: evt.id }); });
      stream.onAbort(() => unsub());
      while (!stream.aborted) await stream.sleep(10_000);
    });
  });

  app.post("/api/jobs/:id/cancel", async (c) => {
    const job = await runner.cancel(c.req.param("id"));
    return c.json({ job: store.pub(job) });
  });

  app.post("/api/run", async (c) => {
    const body = await c.req.json();
    const prompt = body.prompt || body.instructions;
    if (!prompt) return c.json({ error: "Missing prompt" }, 400);
    const job = await store.create({
      kind: body.kind || "agent",
      title: body.title || body.issueKey || "run",
      issueKey: body.issueKey || null,
      prompt,
      model: body.model || config.runtime.model,
      body,
      autoComment: body.autoComment,
    });
    runner.enqueue(job);
    return c.json({ job: store.pub(job) }, 202);
  });

  // Extension routes
  registerRoutes(app, { config, store, runner }, extensions);

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((e, c) => { console.error("[server]", e); return c.json({ error: e.message }, 500); });
  return app;
}
