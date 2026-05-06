import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { slug } from "../../src/core/ids.mjs";

/**
 * Host-side bare repo cache + per-job worktree creation.
 *
 * Cache layout:
 *   .data/repo-cache/github.com/<owner>/<repo>.git   (bare mirror)
 *
 * Worktree layout:
 *   <jobWorkspacePath>/repos/<owner>__<repo>/         (working copy)
 *   branch: agent/<jobId>
 */
export class RepoCache {
  constructor(config, token) {
    this.config = config;
    this._token = token || null;
  }

  _cachePath(owner, repo) {
    return resolve(this.config.paths.repoCache, "github.com", owner, `${repo}.git`);
  }

  _authArgs() {
    const token = this._token || this.config.github?.token;
    if (!token) return [];
    return ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
  }

  _git(cwd, args, timeout = 180_000) {
    const allArgs = [...this._authArgs(), ...args];
    const quoted = allArgs.map((a) => `'${String(a).replaceAll("'", "'\\''")}'`).join(" ");
    const result = execSync(`git ${quoted}`, { cwd, stdio: "pipe", timeout });
    return result.toString().trim();
  }

  /**
   * Ensure the bare cache for a repo is up to date.
   * Returns the cache path.
   */
  async ensureCache(owner, repo) {
    const cache = this._cachePath(owner, repo);
    await mkdir(resolve(cache, ".."), { recursive: true });
    const url = `https://github.com/${owner}/${repo}.git`;
    if (!existsSync(cache)) {
      console.log(`[repo-cache] cloning ${owner}/${repo} (first time)...`);
      this._git(resolve(cache, ".."), ["clone", "--mirror", url, cache]);
    } else {
      console.log(`[repo-cache] fetching ${owner}/${repo}...`);
      try { this._git(cache, ["remote", "update", "--prune"]); } catch (e) { console.log(`[repo-cache] fetch warning:`, e.message.slice(0, 200)); }
    }
    return cache;
  }

  /**
   * Create a worktree for a job.
   * Returns { hostPath, branch, agentPath }
   */
  async createWorktree(owner, repo, jobId, jobWorkspacePath) {
    const cache = await this.ensureCache(owner, repo);
    const dirName = `${slug(owner)}__${slug(repo)}`;
    const hostPath = resolve(jobWorkspacePath, "repos", dirName);
    const branch = `agent/${jobId}`;
    await mkdir(resolve(jobWorkspacePath, "repos"), { recursive: true });

    // Clean up if exists
    try { this._git(cache, ["worktree", "prune"]); } catch {}
    if (existsSync(hostPath)) {
      const { rmSync } = await import("node:fs");
      rmSync(hostPath, { recursive: true, force: true });
    }

    this._git(cache, ["worktree", "add", "-B", branch, hostPath, "HEAD"]);
    console.log(`[repo-cache] worktree created: ${hostPath} branch: ${branch}`);
    return { hostPath, branch, agentPath: `/home/user/workspace/${dirName}` };
  }
}
