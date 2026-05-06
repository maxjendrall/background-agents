import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { slug } from "../../src/core/ids.mjs";
import { parseGitHubRepo } from "../github/index.mjs";

function mapPath(config, job, agentPath) {
  if (!agentPath || agentPath === "/workspace") return config.workspace.path || job.workspacePath;
  if (agentPath.startsWith("/job/")) return resolve(job.workspacePath, agentPath.replace(/^\/job\/?/, ""));
  if (agentPath.startsWith("/workspace/")) return resolve(config.workspace.path, agentPath.replace(/^\/workspace\/?/, ""));
  return config.workspace.path || job.workspacePath;
}

export function repoExtension() {
  return {
    id: "repo",
    description: "Repo cache and worktree tools",
    toolkits({ config, job, processes }) {
      async function git(cwd, args) {
        const tokenArgs = config.github.token ? ["-c", `http.extraHeader=Authorization: Bearer ${config.github.token}`] : [];
        const all = [...tokenArgs, ...args].map((a) => `'${String(a).replaceAll("'", "'\\''")}'`).join(" ");
        const r = await processes.run({ command: `git ${all}`, cwd, timeout: 180_000 });
        if (r.code !== 0) throw new Error(`git failed: ${r.stderr || r.stdout}`);
        return r;
      }

      return [toolKit({
        name: "repo",
        description: "Clone, worktree, diff, commit, push",
        tools: {
          materialize: hostTool({
            description: "Clone/update a GitHub repo into a per-job worktree under /job/repos.",
            inputSchema: z.object({ repo: z.string(), ref: z.string().default("HEAD"), branch: z.string().optional() }),
            execute: async ({ repo, ref, branch }) => {
              const parsed = parseGitHubRepo(repo);
              if (!parsed) throw new Error(`Invalid repo: ${repo}`);
              const cache = resolve(config.paths.repoCache, "github.com", parsed.owner, `${parsed.repo}.git`);
              const url = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
              await mkdir(resolve(cache, ".."), { recursive: true });
              if (!existsSync(cache)) await git(config.paths.repoCache, ["clone", "--mirror", url, cache]);
              else await git(cache, ["remote", "update", "--prune"]);
              const dirName = `${slug(parsed.owner)}__${slug(parsed.repo)}`;
              const wt = resolve(job.workspacePath, "repos", dirName);
              const branchName = branch || `agent/${job.issueKey || job.id}`;
              await mkdir(resolve(job.workspacePath, "repos"), { recursive: true });
              if (existsSync(wt)) await rm(wt, { recursive: true });
              await git(cache, ["worktree", "prune"]);
              await git(cache, ["worktree", "add", "-B", branchName, wt, ref]);
              return { repo: `${parsed.owner}/${parsed.repo}`, branch: branchName, path: `/job/repos/${dirName}`, hostPath: wt };
            },
          }),
          status: hostTool({ description: "Git status.", inputSchema: z.object({ path: z.string().default("/workspace") }), execute: ({ path }) => processes.run({ command: "git status --short --branch", cwd: mapPath(config, job, path) }) }),
          diff: hostTool({ description: "Git diff.", inputSchema: z.object({ path: z.string().default("/workspace") }), execute: ({ path }) => processes.run({ command: "git diff --stat && git diff", cwd: mapPath(config, job, path) }) }),
          commit_all: hostTool({ description: "Stage and commit all.", inputSchema: z.object({ path: z.string().default("/workspace"), message: z.string() }), execute: async ({ path, message }) => { const cwd = mapPath(config, job, path); await processes.run({ command: "git add -A", cwd }); return processes.run({ command: `git commit -m ${JSON.stringify(message)}`, cwd }); } }),
          push: hostTool({ description: "Push branch.", inputSchema: z.object({ path: z.string().default("/workspace"), branch: z.string() }), execute: async ({ path, branch }) => { if (!config.github.allowPush) throw new Error("Push disabled"); return git(mapPath(config, job, path), ["push", "-u", "origin", branch]); } }),
        },
      })];
    },
  };
}
