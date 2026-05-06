import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function mapRepoPath(config, job, agentPath) {
  // Map agent VFS path to host path
  // /home/user/workspace/repos/<name> -> <jobWorkspacePath>/repos/<name>
  if (agentPath.startsWith("/home/user/workspace/repos/")) {
    const rel = agentPath.replace("/home/user/workspace/repos/", "");
    return resolve(job.workspacePath, "repos", rel);
  }
  if (agentPath.startsWith("/home/user/workspace/")) {
    const rel = agentPath.replace("/home/user/workspace/", "");
    return resolve(job.workspacePath, rel);
  }
  if (agentPath === "/home/user/workspace") return job.workspacePath;
  return agentPath;
}

function getGitToken(config) {
  try {
    const p = resolve(config.paths.data, "github-oauth-tokens.json");
    if (existsSync(p)) return JSON.parse(require("node:fs").readFileSync(p, "utf8")).access_token;
  } catch {}
  // Try GitHub App token
  try {
    const { GitHubClient } = require("../github/client.mjs");
    // Can't do async here, token must be pre-fetched
  } catch {}
  return config.github?.token || null;
}

function git(cwd, args, token) {
  // Use URL-embedded token for push
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 120_000 }).toString().trim();
}

function findRepoDirs(job) {
  const dirs = [];
  const reposDir = resolve(job.workspacePath, "repos");
  if (existsSync(reposDir)) {
    for (const name of require("node:fs").readdirSync(reposDir)) {
      const p = resolve(reposDir, name);
      if (existsSync(resolve(p, ".git"))) dirs.push({ hostPath: p, agentPath: `/home/user/workspace/repos/${name}` });
    }
  }
  if (existsSync(resolve(job.workspacePath, ".git"))) {
    dirs.push({ hostPath: job.workspacePath, agentPath: "/home/user/workspace" });
  }
  return dirs;
}

export function gitExtension() {
  return {
    id: "git",
    description: "Git status, diff, commit, push tools (host-side)",

    toolkits({ config, job }) {
      return [toolKit({
        name: "git",
        description: "Git operations on workspace repos",
        tools: {
          status: hostTool({
            description: "Show git status. If no path given, shows all repos.",
            inputSchema: z.object({ path: z.string().optional() }),
            execute: ({ path }) => {
              const dirs = path ? [{ hostPath: mapRepoPath(config, job, path), agentPath: path }] : findRepoDirs(job);
              if (!dirs.length) return { text: "No git repos found" };
              const results = dirs.map((d) => {
                try { return `${d.agentPath}:\n${git(d.hostPath, ["status", "--short", "--branch"])}`; }
                catch (e) { return `${d.agentPath}: error: ${e.message.slice(0, 200)}`; }
              });
              return { text: results.join("\n\n") };
            },
          }),

          diff: hostTool({
            description: "Show uncommitted changes.",
            inputSchema: z.object({ path: z.string() }),
            execute: ({ path }) => {
              const hostPath = mapRepoPath(config, job, path);
              try {
                const stat = git(hostPath, ["diff", "--stat"]);
                const diff = git(hostPath, ["diff"]);
                return { text: (stat + "\n\n" + diff).trim() || "No changes" };
              } catch (e) { return { text: "Error: " + e.message.slice(0, 300) }; }
            },
          }),

          commit: hostTool({
            description: "Stage all changes and commit.",
            inputSchema: z.object({ path: z.string(), message: z.string() }),
            execute: ({ path, message }) => {
              const hostPath = mapRepoPath(config, job, path);
              try {
                git(hostPath, ["add", "-A"]);
                const result = git(hostPath, ["commit", "-m", message]);
                return { text: result };
              } catch (e) {
                if (e.message.includes("nothing to commit")) return { text: "Nothing to commit" };
                return { text: "Error: " + e.message.slice(0, 300) };
              }
            },
          }),

          push: hostTool({
            description: "Push current branch to origin.",
            inputSchema: z.object({ path: z.string() }),
            execute: async ({ path }) => {
              const hostPath = mapRepoPath(config, job, path);
              try {
                // Get a fresh GitHub App token for push
                let token = null;
                try {
                  const { GitHubClient } = await import("../github/client.mjs");
                  const gh = new GitHubClient(config);
                  if (gh.configured) token = await gh.getInstallationToken();
                } catch {}

                // Set remote URL with token for auth
                if (token) {
                  const remoteUrl = git(hostPath, ["remote", "get-url", "origin"]);
                  const authedUrl = remoteUrl.replace(/https:\/\/([^@]*@)?github\.com\//, `https://x-access-token:${token}@github.com/`);
                  git(hostPath, ["remote", "set-url", "origin", authedUrl]);
                }

                const branch = git(hostPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
                const result = git(hostPath, ["push", "-u", "origin", branch]);
                return { text: `Pushed ${branch}\n${result}` };
              } catch (e) { return { text: "Error: " + e.message.slice(0, 300) }; }
            },
          }),

          log: hostTool({
            description: "Show recent git log.",
            inputSchema: z.object({ path: z.string(), count: z.number().default(10) }),
            execute: ({ path, count }) => {
              const hostPath = mapRepoPath(config, job, path);
              try {
                return { text: git(hostPath, ["log", `--oneline`, `-${count}`]) };
              } catch (e) { return { text: "Error: " + e.message.slice(0, 300) }; }
            },
          }),
        },
      })];
    },
  };
}
