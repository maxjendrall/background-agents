#!/usr/bin/env node
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENV_FILES = ["/root/background-agents/.env", "/etc/background-agents-deployer.env"];

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

for (const file of ENV_FILES) loadEnvFile(file);

const port = Number(process.env.DEPLOYER_PORT || 8790);
const host = process.env.DEPLOYER_HOST || "127.0.0.1";
const secret = process.env.GITHUB_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "";
const branch = process.env.DEPLOY_BRANCH || "main";
const allowedRepo = process.env.DEPLOY_REPO || "";
const queueDir = process.env.QUEUE_DIR || "/var/lib/background-agents-deployer";
const workerService = process.env.DEPLOY_WORKER_SERVICE || "background-agents-deploy-worker.service";
const pendingPath = join(queueDir, "pending.json");
const webhookLogPath = join(queueDir, "webhooks.jsonl");

if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET is required");
  process.exit(1);
}

await mkdir(queueDir, { recursive: true });

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req, maxBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function verifySignature(body, signature) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function logWebhook(entry) {
  await appendFile(webhookLogPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

async function writePending(payload) {
  const tmp = join(queueDir, `pending.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tmp, pendingPath);
}

function startWorker() {
  const child = spawn("systemctl", ["start", workerService], { stdio: "ignore", detached: true });
  child.unref();
  return workerService;
}

createServer(async (req, res) => {
  try {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const body = await readBody(req);
    const delivery = req.headers["x-github-delivery"] || "";
    const event = req.headers["x-github-event"] || "";
    const signature = req.headers["x-hub-signature-256"] || "";
    if (!verifySignature(body, signature)) {
      await logWebhook({ delivery, event, accepted: false, reason: "bad_signature" }).catch(() => {});
      return json(res, 401, { ok: false, error: "bad_signature" });
    }

    const payload = JSON.parse(body.toString("utf8"));
    if (event === "ping") {
      await logWebhook({ delivery, event, accepted: true, action: "ping" }).catch(() => {});
      return json(res, 200, { ok: true, event: "ping" });
    }
    if (event !== "push") {
      await logWebhook({ delivery, event, accepted: true, ignored: true, reason: "event" }).catch(() => {});
      return json(res, 202, { ok: true, ignored: true, reason: "event", event });
    }

    const repo = payload.repository?.full_name;
    const ref = payload.ref;
    const sha = payload.after;
    if (!repo || !sha || !ref) return json(res, 400, { ok: false, error: "missing_repo_ref_or_sha" });
    if (allowedRepo && repo !== allowedRepo) {
      await logWebhook({ delivery, event, repo, ref, sha, accepted: true, ignored: true, reason: "repo" }).catch(() => {});
      return json(res, 202, { ok: true, ignored: true, reason: "repo", repo });
    }
    if (ref !== `refs/heads/${branch}`) {
      await logWebhook({ delivery, event, repo, ref, sha, accepted: true, ignored: true, reason: "branch" }).catch(() => {});
      return json(res, 202, { ok: true, ignored: true, reason: "branch", ref });
    }

    const queued = { repo, sha, ref, delivery, receivedAt: new Date().toISOString() };
    await writePending(queued);
    await logWebhook({ delivery, event, repo, ref, sha, accepted: true, queued: true });
    const service = startWorker();
    console.log(JSON.stringify({ ts: new Date().toISOString(), delivery, event, repo, ref, sha, service, queued: true }));
    return json(res, 202, { ok: true, queued: true, service, repo, sha });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: error.message || String(error) });
  }
}).listen(port, host, () => {
  console.log(`[background-agents-deployer] http://${host}:${port}`);
  if (existsSync(pendingPath)) startWorker();
});
