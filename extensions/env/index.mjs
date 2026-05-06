import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";

function mapPath(config, job, p) {
  if (!p || p === "/workspace") return config.workspace.path || job.workspacePath;
  if (p.startsWith("/job/")) return p.replace(/^\/job/, job.workspacePath);
  if (p.startsWith("/workspace/") && config.workspace.path) return p.replace(/^\/workspace/, config.workspace.path);
  return config.workspace.path || job.workspacePath;
}

export function envExtension() {
  return {
    id: "env",
    description: "Run commands and manage dev servers",
    toolkits({ config, job, processes }) {
      return [toolKit({
        name: "env",
        description: "Shell execution and process management",
        tools: {
          run: hostTool({ description: "Run a shell command.", inputSchema: z.object({ command: z.string(), cwd: z.string().default("/workspace"), timeout: z.number().default(120_000) }), execute: ({ command, cwd, timeout }) => processes.run({ command, cwd: mapPath(config, job, cwd), timeout }) }),
          start: hostTool({ description: "Start a long-running process.", inputSchema: z.object({ name: z.string().optional(), command: z.string(), cwd: z.string().default("/workspace"), port: z.number().optional() }), execute: ({ name, command, cwd, port }) => processes.start({ name, command, cwd: mapPath(config, job, cwd), port }) }),
          stop: hostTool({ description: "Stop a running process.", inputSchema: z.object({ id: z.string() }), execute: ({ id }) => processes.stop(id) }),
          list: hostTool({ description: "List running processes.", inputSchema: z.object({}), execute: () => ({ processes: processes.list() }) }),
        },
      })];
    },
  };
}
