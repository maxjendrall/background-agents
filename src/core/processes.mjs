import { spawn } from "node:child_process";
import { id } from "./ids.mjs";
import { trim } from "./redact.mjs";

function shell(command, { cwd, env, timeout = 120_000 }) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let killed = false;
    const timer = timeout > 0 ? setTimeout(() => { killed = true; child.kill("SIGTERM"); }, timeout) : null;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: trim(stdout, 80_000), stderr: trim(stderr, 80_000), killed });
    });
  });
}

export class Processes {
  constructor() { this.running = new Map(); }

  run(opts) { return shell(opts.command, opts); }

  start({ name, command, cwd, env, port }) {
    const pid = id("proc");
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, stdio: "ignore", detached: false });
    const rec = { id: pid, name: name || pid, command, cwd, port, childPid: child.pid, status: "running", startedAt: new Date().toISOString() };
    child.on("exit", (code) => { rec.status = "exited"; rec.exitCode = code; rec.exitedAt = new Date().toISOString(); });
    this.running.set(pid, { rec, child });
    return rec;
  }

  stop(idOrName) {
    const entry = this.running.get(idOrName) || [...this.running.values()].find((e) => e.rec.name === idOrName);
    if (!entry) throw new Error(`Process not found: ${idOrName}`);
    if (entry.rec.status === "running") entry.child.kill("SIGTERM");
    return entry.rec;
  }

  list() { return [...this.running.values()].map((e) => e.rec); }

  stopAll() { for (const e of this.running.values()) if (e.rec.status === "running") e.child.kill("SIGTERM"); }
}
