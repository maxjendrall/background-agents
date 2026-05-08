#!/usr/bin/env node
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";

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
const deployScript = process.env.DEPLOY_SCRIPT || "/opt/background-agents-deployer/deploy.sh";
const branch = process.env.DEPLOY_BRANCH || "main";
const allowedRepo = process.env.DEPLOY_REPO || "";

if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET is required");
  process.exit(1);
}

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

function startDeploy({ repo, sha, ref, delivery }) {
  const unit = `background-agents-deploy-${Date.now()}`;
  const args = [
    "--unit", unit,
    "--collect",
    "--property", "Type=exec",
    deployScript,
    repo,
    sha,
    ref,
    delivery || "",
  ];
  const child = spawn("systemd-run", args, { stdio: "ignore", detached: true });
  child.unref();
  return unit;
}

createServer(async (req, res) => {
  try {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const body = await readBody(req);
    const delivery = req.headers["x-github-delivery"] || "";
    const event = req.headers["x-github-event"] || "";
    const signature = req.headers["x-hub-signature-256"] || "";
    if (!verifySignature(body, signature)) return json(res, 401, { ok: false, error: "bad_signature" });

    const payload = JSON.parse(body.toString("utf8"));
    if (event === "ping") return json(res, 200, { ok: true, event: "ping" });
    if (event !== "push") return json(res, 202, { ok: true, ignored: true, reason: "event", event });

    const repo = payload.repository?.full_name;
    const ref = payload.ref;
    const sha = payload.after;
    if (!repo || !sha || !ref) return json(res, 400, { ok: false, error: "missing_repo_ref_or_sha" });
    if (allowedRepo && repo !== allowedRepo) return json(res, 202, { ok: true, ignored: true, reason: "repo", repo });
    if (ref !== `refs/heads/${branch}`) return json(res, 202, { ok: true, ignored: true, reason: "branch", ref });

    const unit = startDeploy({ repo, sha, ref, delivery });
    console.log(JSON.stringify({ ts: new Date().toISOString(), delivery, event, repo, ref, sha, unit }));
    return json(res, 202, { ok: true, unit, repo, sha });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: error.message || String(error) });
  }
}).listen(port, host, () => {
  console.log(`[background-agents-deployer] http://${host}:${port}`);
});
