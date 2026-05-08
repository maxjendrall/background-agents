import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { registerRoutes, extensionList } from "../core/extension.mjs";
import { auth } from "./auth.mjs";
import { withJiraCommentPolicy } from "../agents/jira-policy.mjs";

function persistEnv(root, updates) {
  const path = resolve(root, ".env");
  let lines = [];
  try { lines = readFileSync(path, "utf8").split("\n"); } catch {}
  const seen = new Set();
  lines = lines.map((line) => {
    const key = Object.keys(updates).find((k) => line.startsWith(k + "="));
    if (!key) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"));
}

const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readReleaseInfo() {
  let deploy = null;
  try { deploy = JSON.parse(readFileSync(resolve(codeRoot, ".deploy.json"), "utf8")); } catch {}
  let pkg = null;
  try {
    const parsed = JSON.parse(readFileSync(resolve(codeRoot, "package.json"), "utf8"));
    pkg = { name: parsed.name, version: parsed.version };
  } catch {}
  return {
    codeRoot,
    package: pkg,
    deploy,
  };
}

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


  // --- New /app (Vite-built React + AI Elements) ---
  const appDir = resolve(config.root, "app", "dist");
  const serveAppFile = (relPath, mime) => (c) => {
    try {
      const body = readFileSync(resolve(appDir, relPath));
      if (mime) c.header("content-type", mime);
      return c.body(body);
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
  };
  app.get("/app", (c) => {
    try { return c.html(readFileSync(resolve(appDir, "index.html"), "utf8")); }
    catch { return c.html("<h1>App not built</h1><p>Run <code>npm run build</code> in <code>app/</code>.</p>", 503); }
  });
  app.get("/app/", (c) => c.redirect("/app"));
  app.get("/app/assets/:file", (c) => {
    const file = c.req.param("file");
    if (!/^[A-Za-z0-9._-]+$/.test(file)) return c.json({ error: "Bad path" }, 400);
    const mime = file.endsWith(".js") ? "application/javascript"
      : file.endsWith(".css") ? "text/css"
      : file.endsWith(".svg") ? "image/svg+xml"
      : file.endsWith(".woff2") ? "font/woff2"
      : file.endsWith(".woff") ? "font/woff"
      : file.endsWith(".png") ? "image/png"
      : file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg"
      : "application/octet-stream";
    return serveAppFile(`assets/${file}`, mime)(c);
  });
  app.get("/app/*", (c) => {
    try { return c.html(readFileSync(resolve(appDir, "index.html"), "utf8")); }
    catch { return c.json({ error: "Not found" }, 404); }
  });

  // --- Root / Health ---
  app.get("/", (c) => c.json({ name: "background-agents" }));
  app.get("/health", (c) => c.json({
    ok: true,
    release: readReleaseInfo(),
    workspace: config.workspace.exists ? config.workspace.path : null,
    model: config.runtime.model,
    thinkingLevel: config.runtime.thinkingLevel,
    concurrency: config.runtime.maxConcurrency,
    queue: runner.queue.length,
    active: runner.active,
    jobs: store.list().length,
    extensions: extensionList(extensions),
  }));

  // --- Config ---
  app.get("/api/config", (c) => c.json({
    model: config.runtime.model,
    thinkingLevel: config.runtime.thinkingLevel,
    concurrency: config.runtime.maxConcurrency,
    workspace: config.workspace.exists ? config.workspace.path : null,
    extensions: extensionList(extensions),
  }));

  app.put("/api/config/model", async (c) => {
    const { model, thinkingLevel, thinking } = await c.req.json();
    if (model !== undefined) {
      if (!model || typeof model !== "string") return c.json({ error: "model must be a non-empty string" }, 400);
      config.runtime.model = model;
    }
    const nextThinking = thinkingLevel || thinking;
    if (nextThinking !== undefined) {
      if (!nextThinking || typeof nextThinking !== "string") return c.json({ error: "thinkingLevel must be a non-empty string" }, 400);
      config.runtime.thinkingLevel = nextThinking;
    }
    persistEnv(config.root, { AGENT_MODEL: config.runtime.model, AGENT_THINKING: config.runtime.thinkingLevel });
    return c.json({ model: config.runtime.model, thinkingLevel: config.runtime.thinkingLevel });
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
    const afterId = c.req.query("after") || c.req.query("afterId") || "";
    const initial = await store.events(job.id, afterId ? { afterId } : {});
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
    // Clear everything: session file, output, result, events
    await store.update(job.id, { piSessionFile: null, output: "", result: null, status: "idle" });
    await store.clearEvents(job.id);
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
    const patch = { status: "queued", prompt: job.issueKey ? withJiraCommentPolicy(prompt) : prompt };
    if (body.model) patch.model = body.model;
    if (body.thinkingLevel || body.thinking) patch.thinkingLevel = body.thinkingLevel || body.thinking;
    if (body.messageMode || body.mode) patch.messageMode = body.messageMode || body.mode;
    if (body.resumeStrategy) patch.resumeStrategy = body.resumeStrategy;
    else if (job.result || job.output) patch.resumeStrategy = "context";
    // Update the job with the new prompt/config and re-enqueue
    await store.update(job.id, patch);
    await store.event(job.id, "follow_up.queued", { prompt: prompt.slice(0, 50_000), model: patch.model || job.model, thinkingLevel: patch.thinkingLevel || job.thinkingLevel, messageMode: patch.messageMode || job.messageMode || "follow_up", resumeStrategy: patch.resumeStrategy || job.resumeStrategy || "persisted" });
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
      thinkingLevel: body.thinkingLevel || body.thinking || config.runtime.thinkingLevel,
      messageMode: body.messageMode || body.mode || "follow_up",
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
