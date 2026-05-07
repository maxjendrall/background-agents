import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import path from "node:path";

const GUEST_WORKSPACE = "/workspace";
const SECRET_BASENAMES = new Set([".env", ".env.local", ".env.production", ".env.development", ".npmrc"]);
const SECRET_PREFIXES = ["/.ssh", "/.gnupg", "/secrets"];

function posixNormalize(p) {
  return path.posix.normalize(String(p || "").replaceAll("\\", "/"));
}

export function toGuestPath(inputPath, cwd = GUEST_WORKSPACE) {
  const raw = String(inputPath || "").trim();
  if (!raw) return posixNormalize(cwd || GUEST_WORKSPACE);
  if (raw === "/home/user/workspace") return GUEST_WORKSPACE;
  if (raw.startsWith("/home/user/workspace/")) return posixNormalize(GUEST_WORKSPACE + raw.slice("/home/user/workspace".length));
  if (raw === GUEST_WORKSPACE || raw.startsWith(`${GUEST_WORKSPACE}/`)) return posixNormalize(raw);
  if (path.posix.isAbsolute(raw)) return posixNormalize(raw);
  return posixNormalize(path.posix.join(toGuestPath(cwd || GUEST_WORKSPACE), raw));
}

export function toWorkspaceGuestPath(inputPath, cwd = GUEST_WORKSPACE) {
  const guestPath = toGuestPath(inputPath, cwd);
  if (guestPath !== GUEST_WORKSPACE && !guestPath.startsWith(`${GUEST_WORKSPACE}/`)) {
    throw new Error(`MicroVM file tools are limited to ${GUEST_WORKSPACE}; got ${guestPath}`);
  }
  return guestPath;
}

function shadowSecrets({ path: p }) {
  const normalized = posixNormalize(p);
  const base = path.posix.basename(normalized);
  if (SECRET_BASENAMES.has(base)) return true;
  return SECRET_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`) || normalized.includes(`${prefix}/`));
}

async function loadGondolin() {
  try {
    return await import("@earendil-works/gondolin");
  } catch (e) {
    throw new Error(`MicroVM support requires @earendil-works/gondolin. Run npm install. ${e.message || e}`);
  }
}

async function createWorkspaceProvider(gondolin, hostWorkspacePath) {
  const { RealFSProvider, ShadowProvider } = gondolin;
  return new ShadowProvider(new RealFSProvider(hostWorkspacePath), {
    shouldShadow: shadowSecrets,
    writeMode: "deny",
  });
}

function createHttpOptions(gondolin, config) {
  const allowedHosts = config.microvm?.allowedHosts || [];
  if (!allowedHosts.length) return {};
  const { httpHooks, env } = gondolin.createHttpHooks({ allowedHosts });
  return { httpHooks, env };
}

async function vmOptions({ config, job, label }) {
  const gondolin = await loadGondolin();
  const mounts = {};
  if (job?.workspacePath) mounts[GUEST_WORKSPACE] = await createWorkspaceProvider(gondolin, job.workspacePath);
  return {
    ...createHttpOptions(gondolin, config),
    vfs: Object.keys(mounts).length ? { mounts } : undefined,
    rootfs: { mode: "cow" },
    sandbox: {
      ...(config.microvm?.imagePath ? { imagePath: config.microvm.imagePath } : {}),
    },
    memory: config.microvm?.memory || "1536M",
    cpus: config.microvm?.cpus || 2,
    startTimeoutMs: config.microvm?.startTimeoutMs || 120_000,
    sessionLabel: label,
  };
}

async function createVm({ config, job }) {
  const gondolin = await loadGondolin();
  const options = await vmOptions({ config, job, label: `background-agent ${job?.id || "snapshot"}` });
  if (config.microvm?.snapshotPath && existsSync(config.microvm.snapshotPath)) {
    const checkpoint = gondolin.VmCheckpoint.load(config.microvm.snapshotPath);
    return checkpoint.resume(options);
  }
  return gondolin.VM.create(options);
}

async function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class MicroVmManager {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.starting = new Map();
    this.reaper = setInterval(() => this.reapIdle(), 60_000);
    this.reaper.unref?.();
  }

  assertEnabled() {
    if (!this.config.microvm?.enabled) throw new Error("MicroVM tools are disabled. Set MICROVM_ENABLED=true and configure Gondolin/QEMU.");
  }

  activeCount() { return this.sessions.size + this.starting.size; }

  async ensure(job) {
    this.assertEnabled();
    if (!job?.id || !job?.workspacePath) throw new Error("MicroVM tools require a job workspace");
    const existing = this.sessions.get(job.id);
    if (existing) { existing.lastUsed = Date.now(); return existing.vm; }
    const pending = this.starting.get(job.id);
    if (pending) return pending;
    const max = this.config.microvm?.maxActive || 2;
    if (this.activeCount() >= max) throw new Error(`MicroVM capacity reached (${max}). Try again after another job VM idles out.`);
    const start = createVm({ config: this.config, job }).then((vm) => {
      this.sessions.set(job.id, { vm, lastUsed: Date.now() });
      return vm;
    }).finally(() => this.starting.delete(job.id));
    this.starting.set(job.id, start);
    return start;
  }

  async bash(job, { command, cwd = GUEST_WORKSPACE, timeout = 120, env = {} }) {
    const vm = await this.ensure(job);
    const guestCwd = toGuestPath(cwd || GUEST_WORKSPACE);
    const ac = new AbortController();
    const timer = timeout && timeout > 0 ? setTimeout(() => ac.abort(), timeout * 1000) : null;
    timer?.unref?.();
    try {
      const result = await vm.exec(["/bin/bash", "-lc", command], { cwd: guestCwd, env, signal: ac.signal });
      return { exitCode: result.exitCode, ok: result.ok, stdout: result.stdout || "", stderr: result.stderr || "", cwd: guestCwd };
    } catch (e) {
      if (ac.signal.aborted) return { exitCode: 124, ok: false, stdout: "", stderr: `Timed out after ${timeout}s`, cwd: guestCwd };
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      const s = this.sessions.get(job.id); if (s) s.lastUsed = Date.now();
    }
  }

  async read(job, { path: filePath, cwd = GUEST_WORKSPACE, maxBytes = 200_000 }) {
    const vm = await this.ensure(job);
    const guestPath = toWorkspaceGuestPath(filePath, cwd);
    const text = await vm.fs.readFile(guestPath, { encoding: "utf-8" });
    const truncated = text.length > maxBytes;
    return { path: guestPath, text: truncated ? text.slice(0, maxBytes) : text, truncated, bytes: Buffer.byteLength(text) };
  }

  async write(job, { path: filePath, content, cwd = GUEST_WORKSPACE }) {
    const vm = await this.ensure(job);
    const guestPath = toWorkspaceGuestPath(filePath, cwd);
    await vm.fs.mkdir(path.posix.dirname(guestPath), { recursive: true });
    await vm.fs.writeFile(guestPath, String(content ?? ""));
    return { path: guestPath, bytes: Buffer.byteLength(String(content ?? "")) };
  }

  async edit(job, { path: filePath, oldText, newText, cwd = GUEST_WORKSPACE }) {
    const vm = await this.ensure(job);
    const guestPath = toWorkspaceGuestPath(filePath, cwd);
    const text = await vm.fs.readFile(guestPath, { encoding: "utf-8" });
    if (!text.includes(oldText)) throw new Error(`oldText not found in ${guestPath}`);
    const next = text.replace(oldText, newText);
    await vm.fs.writeFile(guestPath, next);
    return { path: guestPath, replacements: 1, bytes: Buffer.byteLength(next) };
  }

  async closeJob(jobId) {
    const session = this.sessions.get(jobId);
    this.sessions.delete(jobId);
    if (session) await session.vm.close().catch(() => {});
  }

  reapIdle() {
    const idleMs = this.config.microvm?.idleMs || 600_000;
    const now = Date.now();
    for (const [jobId, session] of this.sessions) {
      if (now - session.lastUsed > idleMs) void this.closeJob(jobId);
    }
  }

  async disposeAll() {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((jobId) => this.closeJob(jobId)));
  }
}

export async function prepareSnapshot(config, { force = false, command } = {}) {
  if (!config.microvm?.snapshotPath) throw new Error("MICROVM_SNAPSHOT_PATH is required");
  const snapshotPath = config.microvm.snapshotPath;
  if (existsSync(snapshotPath) && !force) return { snapshotPath, created: false };
  await mkdir(dirname(snapshotPath), { recursive: true });
  const gondolin = await loadGondolin();
  const options = await vmOptions({ config, job: null, label: "background-agents microvm base snapshot" });
  const vm = await gondolin.VM.create(options);
  const bootstrap = command || config.microvm?.bootstrapCommand || DEFAULT_BOOTSTRAP_COMMAND;
  const result = await withTimeout(vm.exec(["/bin/bash", "-lc", bootstrap]), 20 * 60_000, "MicroVM snapshot bootstrap");
  if (!result.ok) {
    await vm.close().catch(() => {});
    throw new Error(`MicroVM snapshot bootstrap failed (${result.exitCode})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  await vm.checkpoint(resolve(snapshotPath));
  return { snapshotPath, created: true, stdout: result.stdout, stderr: result.stderr };
}

export const DEFAULT_BOOTSTRAP_COMMAND = `
set -eux
if command -v apk >/dev/null 2>&1; then
  apk add --no-cache bash git curl ca-certificates nodejs npm chromium dbus mesa-dri-gallium font-noto xvfb-run gsettings-desktop-schemas file ripgrep
fi
if ! command -v corepack >/dev/null 2>&1; then
  npm install -g corepack
fi
corepack enable || true
corepack prepare yarn@4.1.0 --activate || npm install -g yarn@1.22.22
if ! command -v yarn >/dev/null 2>&1; then
  npm install -g yarn@1.22.22
fi
if ! command -v agent-browser >/dev/null 2>&1; then
  npm install -g agent-browser@0.26.0
fi
if ! command -v nvm >/dev/null 2>&1; then
  cat > /usr/local/bin/nvm <<'EOF'
#!/bin/sh
case "$1" in
  --version) echo "microvm-nvm-shim" ;;
  current) node -v ;;
  use|install) echo "MicroVM image provides preinstalled Node $(node -v). Rebuild the image/snapshot to change Node." ;;
  *) echo "MicroVM nvm shim: node=$(node -v) npm=$(npm -v)" ;;
esac
EOF
  chmod +x /usr/local/bin/nvm
fi
node -v
npm -v
yarn -v
nvm --version
agent-browser --help >/dev/null
`;
