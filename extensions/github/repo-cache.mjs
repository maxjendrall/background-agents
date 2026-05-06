import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { slug } from "../../src/core/ids.mjs";

export class RepoCache {
  constructor(config, token) {
    this.config = config;
    this._token = token || null;
  }

  _cachePath(owner, repo) {
    return resolve(this.config.paths.repoCache, "github.com", owner, `${repo}.git`);
  }

  _repoUrl(owner, repo) {
    const token = this._token || this.config.github?.token;
    if (token) return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    return `https://github.com/${owner}/${repo}.git`;
  }

  _git(cwd, args, timeout = 180_000) {
    return execFileSync("git", args, { cwd, stdio: "pipe", timeout }).toString().trim();
  }

  async ensureCache(owner, repo) {
    const cache = this._cachePath(owner, repo);
    await mkdir(resolve(cache, ".."), { recursive: true });
    const url = this._repoUrl(owner, repo);
    if (!existsSync(cache)) {
      console.log(`[repo-cache] cloning ${owner}/${repo} (first time)...`);
      this._git(resolve(cache, ".."), ["clone", "--mirror", url, cache]);
    } else {
      console.log(`[repo-cache] fetching ${owner}/${repo}...`);
      // Update remote URL in case token changed
      try { this._git(cache, ["remote", "set-url", "origin", url]); } catch {}
      try { this._git(cache, ["remote", "update", "--prune"]); } catch (e) { console.log(`[repo-cache] fetch warning:`, e.message.slice(0, 200)); }
    }
    return cache;
  }

  async createWorktree(owner, repo, jobId, jobWorkspacePath) {
    const cache = await this.ensureCache(owner, repo);
    const dirName = `${slug(owner)}__${slug(repo)}`;
    const hostPath = resolve(jobWorkspacePath, "repos", dirName);
    const branch = `agent/${jobId}`;
    await mkdir(resolve(jobWorkspacePath, "repos"), { recursive: true });

    // Clean up stale worktree references and old directory
    if (existsSync(hostPath)) {
      const { rmSync } = await import("node:fs");
      rmSync(hostPath, { recursive: true, force: true });
    }
    try { this._git(cache, ["worktree", "prune"]); } catch {}
    // Force-remove the branch if it exists from a previous run
    try { this._git(cache, ["branch", "-D", branch]); } catch {}

    this._git(cache, ["worktree", "add", "-B", branch, hostPath, "HEAD"]);
    console.log(`[repo-cache] worktree created: ${hostPath} branch: ${branch}`);
    return { hostPath, branch, agentPath: `/home/user/workspace/repos/${dirName}` };
  }
}
