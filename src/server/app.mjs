import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { registerRoutes, extensionList } from "../core/extension.mjs";
import { auth } from "./auth.mjs";

export function createApp({ config, store, runner, runtime, extensions }) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("config", config); await next(); });
  app.use("*", cors());

  // --- Login page ---
  app.get("/login", (c) => {
    const token = config.server.token;
    if (!token) return c.redirect("/ui");
    return c.html(`<!DOCTYPE html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;justify-content:center;align-items:center;min-height:100vh}
.box{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:32px;width:340px}h1{font-size:18px;margin-bottom:16px}
input{width:100%;padding:10px;border:1px solid #30363d;border-radius:6px;background:#0d1117;color:#c9d1d9;font-size:14px;margin-bottom:12px}
button{width:100%;padding:10px;border:none;border-radius:6px;background:#238636;color:#fff;font-size:14px;cursor:pointer}button:hover{background:#2ea043}
.err{color:#f85149;font-size:13px;margin-bottom:8px;display:none}</style></head><body>
<div class="box"><h1>Background Agents</h1><div class="err" id="err">Invalid token</div>
<form onsubmit="event.preventDefault();const t=document.getElementById('t').value;document.cookie='auth_token='+t+';path=/;max-age=31536000';
fetch('/health',{headers:{Authorization:'Bearer '+t}}).then(r=>{if(r.ok){localStorage.setItem('bg-agents-token',t);location.href='/ui'}else{document.getElementById('err').style.display='block'}}).catch(()=>{document.getElementById('err').style.display='block'})">
<input id="t" type="password" placeholder="Token" autofocus><button type="submit">Login</button></form></div></body></html>`);
  });

  // --- Auth on everything except login and Jira webhook ---
  app.use("*", async (c, next) => {
    const path = c.req.path;
    // Allow login page and Jira webhook (needs to be callable by Jira servers)
    if (path === "/login" || path === "/api/jira/webhook") return next();
    // Apply auth
    return auth(c, next);
  });

  // --- UI (protected) ---
  const uiDir = resolve(config.root, "ui");
  app.get("/ui", (c) => c.html(readFileSync(resolve(uiDir, "index.html"), "utf8")));
  app.get("/ui/app.js", (c) => { c.header("content-type", "application/javascript"); return c.body(readFileSync(resolve(uiDir, "app.js"), "utf8")); });
  app.get("/ui/style.css", (c) => { c.header("content-type", "text/css"); return c.body(readFileSync(resolve(uiDir, "style.css"), "utf8")); });

  // --- Root / Health ---
  app.get("/", (c) => c.json({ name: "background-agents" }));
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

  // --- Config ---
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

  // --- Jobs ---
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

  // Reset: clear Pi session history, start fresh on next prompt
  app.post("/api/jobs/:id/reset", async (c) => {
    const job = store.get(c.req.param("id"));
    if (!job) return c.json({ error: "Not found" }, 404);
    // Dispose live session if any
    runtime.disposeJob(job.id);
    // Clear the persisted session file reference so next run creates a fresh session
    await store.update(job.id, { piSessionFile: null, status: "idle" });
    await store.event(job.id, "session.reset", { reason: "user reset" });
    return c.json({ job: store.pub(store.get(job.id)), reset: true });
  });

  // Follow-up: send a new prompt to an existing session
  app.post("/api/jobs/:id/prompt", async (c) => {
    const job = store.get(c.req.param("id"));
    if (!job) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json();
    const prompt = body.prompt || body.text;
    if (!prompt) return c.json({ error: "Missing prompt" }, 400);
    // Update the job with the new prompt and re-enqueue
    await store.update(job.id, { status: "queued", prompt });
    await store.event(job.id, "follow_up.queued", { prompt: prompt.slice(0, 50_000) });
    runner.enqueue(store.get(job.id));
    return c.json({ job: store.pub(store.get(job.id)) }, 202);
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

  // Extension routes (includes Jira OAuth callback which needs to work during auth flow)
  registerRoutes(app, { config, store, runner }, extensions);

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((e, c) => { console.error("[server]", e); return c.json({ error: e.message }, 500); });
  return app;
}
