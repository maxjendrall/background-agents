import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { MicroVmManager, prepareSnapshot } from "./manager.mjs";

export function microVmExtension() {
  const managers = new Map();
  function manager(config) {
    let m = managers.get(config);
    if (!m) { m = new MicroVmManager(config); managers.set(config, m); }
    return m;
  }

  return {
    id: "microvm",
    description: "Gondolin MicroVM tools for isolated command/file execution",

    routes(app, { config }) {
      app.get("/api/microvm/status", (c) => {
        let qemu = null;
        try { qemu = execFileSync("bash", ["-lc", "command -v qemu-system-x86_64 || command -v qemu-system-aarch64 || true"], { encoding: "utf8" }).trim() || null; } catch {}
        return c.json({
          enabled: config.microvm.enabled,
          snapshotPath: config.microvm.snapshotPath,
          snapshotExists: Boolean(config.microvm.snapshotPath && existsSync(config.microvm.snapshotPath)),
          imagePath: config.microvm.imagePath || null,
          memory: config.microvm.memory,
          cpus: config.microvm.cpus,
          maxActive: config.microvm.maxActive,
          qemu,
        });
      });
      app.post("/api/microvm/prepare", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const result = await prepareSnapshot(config, { force: Boolean(body.force), command: body.command });
        return c.json(result);
      });
    },

    async dispose() {
      await Promise.all([...managers.values()].map((m) => m.disposeAll()));
    },

    toolkits({ config, job }) {
      const vm = manager(config);
      return [toolKit({
        name: "microvm",
        description: "Run commands and edit files inside a per-job Gondolin MicroVM mounted at /workspace.",
        tools: {
          bash: hostTool({
            description: "Run a shell command inside the per-job MicroVM. Use for builds/tests/node/npm/agent-browser. Workspace is mounted at /workspace.",
            inputSchema: z.object({
              command: z.string().min(1),
              cwd: z.string().default("/workspace"),
              timeout: z.number().default(120),
              env: z.record(z.string(), z.string()).default({}),
            }),
            execute: async (input) => vm.bash(job, input),
          }),
          read: hostTool({
            description: "Read a text file from the MicroVM workspace.",
            inputSchema: z.object({ path: z.string().min(1), cwd: z.string().default("/workspace"), maxBytes: z.number().default(200_000) }),
            execute: (input) => vm.read(job, input),
          }),
          write: hostTool({
            description: "Write a text file in the MicroVM workspace.",
            inputSchema: z.object({ path: z.string().min(1), content: z.string(), cwd: z.string().default("/workspace") }),
            execute: (input) => vm.write(job, input),
          }),
          edit: hostTool({
            description: "Replace exact text in a MicroVM workspace file.",
            inputSchema: z.object({ path: z.string().min(1), oldText: z.string(), newText: z.string(), cwd: z.string().default("/workspace") }),
            execute: (input) => vm.edit(job, input),
          }),
          close: hostTool({
            description: "Close this job's MicroVM to free resources.",
            inputSchema: z.object({}),
            execute: async () => { await vm.closeJob(job.id); return { closed: true }; },
          }),
        },
      })];
    },
  };
}
