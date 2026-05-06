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

    // If worktree already exists with a .git file, reuse it (preserves changes)
    if (existsSync(resolve(hostPath, ".git"))) {
      console.log(`[repo-cache] reusing existing worktree: ${hostPath}`);
      // Ensure git user config exists
      try { this._git(hostPath, ["config", "user.email"]); } catch {
        this._git(hostPath, ["config", "user.email", "paperclip-bot[bot]@users.noreply.github.com"]);
        this._git(hostPath, ["config", "user.name", "paperclip-bot[bot]"]);
      }
      // Fix mirror mode if present
      try { this._git(hostPath, ["config", "--unset", "remote.origin.mirror"]); } catch {}
      try { this._git(hostPath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]); } catch {}
      return { hostPath, branch, agentPath: `/home/user/workspace/repos/${dirName}` };
    }

    // Clean up stale references
    if (existsSync(hostPath)) {
      const { rmSync } = await import("node:fs");
      rmSync(hostPath, { recursive: true, force: true });
    }
    try { this._git(cache, ["worktree", "prune"]); } catch {}

    // Check if branch already exists in cache (has unpushed commits we must keep)
    let branchExists = false;
    try { this._git(cache, ["rev-parse", "--verify", branch]); branchExists = true; } catch {}

    if (branchExists) {
      // Branch exists with possible commits — create worktree on existing branch
      this._git(cache, ["worktree", "add", hostPath, branch]);
    } else {
      // New branch from HEAD
      this._git(cache, ["worktree", "add", "-b", branch, hostPath, "HEAD"]);
    }
    // Configure git user for commits (paperclip-bot identity)
    this._git(hostPath, ["config", "user.email", "paperclip-bot[bot]@users.noreply.github.com"]);
    this._git(hostPath, ["config", "user.name", "paperclip-bot[bot]"]);
    // Fix mirror mode inherited from bare cache — breaks push
    try { this._git(hostPath, ["config", "--unset", "remote.origin.mirror"]); } catch {}
    this._git(hostPath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    console.log(`[repo-cache] worktree created: ${hostPath} branch: ${branch}`);
    return { hostPath, branch, agentPath: `/home/user/workspace/repos/${dirName}` };
  }
}
