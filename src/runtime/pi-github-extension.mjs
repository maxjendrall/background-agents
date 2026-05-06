// Pi extension source code for Git + GitHub tools.
// Written into the Agent OS VFS. Uses node child_process for git
// and fetch for GitHub API.

export function piGitHubExtensionSource() {
  return `
module.exports = function(pi) {
  const GH_TOKEN = process.env.GITHUB_ACCESS_TOKEN;
  const WORKSPACE = "/home/user/workspace";

  // --- Git tools (use node child_process since git isn't in WASM) ---

  function git(cwd, args) {
    const { execFileSync } = require("child_process");
    return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 120000 }).toString().trim();
  }

  function findRepoDirs() {
    const fs = require("fs");
    const path = require("path");
    const dirs = [];
    // Check workspace root
    if (fs.existsSync(path.join(WORKSPACE, ".git"))) dirs.push(WORKSPACE);
    // Check repos/ subdirectory
    const reposDir = path.join(WORKSPACE, "repos");
    if (fs.existsSync(reposDir)) {
      for (const d of fs.readdirSync(reposDir, { withFileTypes: true })) {
        if (d.isDirectory()) {
          const p = path.join(reposDir, d.name);
          if (fs.existsSync(path.join(p, ".git"))) dirs.push(p);
        }
      }
    }
    return dirs;
  }

  pi.registerTool({
    name: "git_status",
    description: "Show git status for a repository. If no path given, shows status for all repos in workspace.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Path to repo (default: auto-detect)" } } },
    execute: async (toolCallId, { path }) => {
      const dirs = path ? [path] : findRepoDirs();
      if (!dirs.length) return { content: [{ type: "text", text: "No git repos found in workspace." }] };
      const results = dirs.map(d => { try { return d + ":\\n" + git(d, ["status", "--short", "--branch"]); } catch(e) { return d + ": error: " + e.message; } });
      return { content: [{ type: "text", text: results.join("\\n\\n") }] };
    },
  });

  pi.registerTool({
    name: "git_diff",
    description: "Show current uncommitted changes in a repository.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Path to repo" } }, required: ["path"] },
    execute: async (toolCallId, { path }) => {
      try {
        const diff = git(path, ["diff", "--stat"]) + "\\n\\n" + git(path, ["diff"]);
        return { content: [{ type: "text", text: diff || "No changes" }] };
      } catch(e) { return { content: [{ type: "text", text: "Error: " + e.message }] }; }
    },
  });

  pi.registerTool({
    name: "git_commit",
    description: "Stage all changes and commit with a message.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Path to repo" }, message: { type: "string", description: "Commit message" } }, required: ["path", "message"] },
    execute: async (toolCallId, { path, message }) => {
      try {
        git(path, ["add", "-A"]);
        const result = git(path, ["commit", "-m", message]);
        return { content: [{ type: "text", text: result }] };
      } catch(e) {
        if (e.message.includes("nothing to commit")) return { content: [{ type: "text", text: "Nothing to commit" }] };
        return { content: [{ type: "text", text: "Error: " + e.message }] };
      }
    },
  });

  pi.registerTool({
    name: "git_push",
    description: "Push the current branch to origin.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Path to repo" } }, required: ["path"] },
    execute: async (toolCallId, { path }) => {
      try {
        const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
        // Set remote URL with embedded token for auth
        if (GH_TOKEN) {
          try {
            const remoteUrl = git(path, ["remote", "get-url", "origin"]);
            const authedUrl = remoteUrl.replace("https://github.com/", "https://x-access-token:" + GH_TOKEN + "@github.com/");
            git(path, ["remote", "set-url", "origin", authedUrl]);
          } catch {}
        }
        const result = git(path, ["push", "-u", "origin", branch]);
        return { content: [{ type: "text", text: "Pushed " + branch + "\\n" + result }] };
      } catch(e) { return { content: [{ type: "text", text: "Error: " + e.message }] }; }
    },
  });

  // --- GitHub API tools ---

  if (!GH_TOKEN) return;

  async function ghReq(path, opts) {
    const res = await fetch("https://api.github.com" + path, { ...opts, headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json", "Content-Type": "application/json", ...(opts?.headers || {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(res.status + " " + text.slice(0, 500));
    return text ? JSON.parse(text) : {};
  }

  pi.registerTool({
    name: "gh_repo_list",
    description: "List accessible GitHub repositories.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Search query (optional)" } } },
    execute: async (toolCallId, { query }) => {
      const result = query
        ? await ghReq("/search/repositories?q=" + encodeURIComponent(query) + "&per_page=20")
        : await ghReq("/user/repos?per_page=30&sort=updated");
      const repos = (result.items || result).map(r => ({ name: r.full_name, description: (r.description || "").slice(0, 100), defaultBranch: r.default_branch, private: r.private }));
      return { content: [{ type: "text", text: JSON.stringify(repos, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "gh_pr_create",
    description: "Create a pull request. The agent branch must be pushed first with git_push.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, head: { type: "string", description: "Branch name to merge from" }, base: { type: "string", description: "Branch to merge into (default: main)" } }, required: ["owner", "repo", "title", "body", "head"] },
    execute: async (toolCallId, { owner, repo, title, body, head, base }) => {
      const pr = await ghReq("/repos/" + owner + "/" + repo + "/pulls", {
        method: "POST",
        body: JSON.stringify({ title, body, head, base: base || "main" }),
      });
      return { content: [{ type: "text", text: "PR #" + pr.number + " created: " + pr.html_url }] };
    },
  });

  pi.registerTool({
    name: "gh_pr_comment",
    description: "Comment on a pull request.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "number" }, body: { type: "string" } }, required: ["owner", "repo", "number", "body"] },
    execute: async (toolCallId, { owner, repo, number, body }) => {
      await ghReq("/repos/" + owner + "/" + repo + "/issues/" + number + "/comments", {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      return { content: [{ type: "text", text: "Commented on PR #" + number }] };
    },
  });
};
`;
}
