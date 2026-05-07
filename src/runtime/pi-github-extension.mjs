// Pi extension source code for GitHub API tools only.
// Git operations are handled by host toolkits (agentos-git).

export function piGitHubExtensionSource() {
  return `
module.exports = function(pi) {
  const GH_TOKEN = process.env.GITHUB_ACCESS_TOKEN;
  if (!GH_TOKEN) return;

  async function ghReq(path, opts) {
    const res = await fetch("https://api.github.com" + path, { ...opts, headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "background-agents/0.1", ...(opts?.headers || {}) } });
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
        : await ghReq("/installation/repositories?per_page=30");
      const repos = (result.items || result.repositories || result).map(r => ({ name: r.full_name, description: (r.description || "").slice(0, 100), defaultBranch: r.default_branch, private: r.private }));
      return { content: [{ type: "text", text: JSON.stringify(repos, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "gh_pr_create",
    description: "Create a pull request. Push the branch first with git_push. Omit base unless a non-default target branch was explicitly requested; the tool uses the repository default branch.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, head: { type: "string", description: "Branch name" }, base: { type: "string", description: "Optional target branch. Omit to use the repository default branch." } }, required: ["owner", "repo", "title", "body", "head"] },
    execute: async (toolCallId, { owner, repo, title, body, head, base }) => {
      const repoInfo = await ghReq("/repos/" + owner + "/" + repo);
      const defaultBranch = repoInfo.default_branch || "main";
      let targetBase = base || defaultBranch;
      if (targetBase === "main" && defaultBranch !== "main") targetBase = defaultBranch;
      const pr = await ghReq("/repos/" + owner + "/" + repo + "/pulls", {
        method: "POST",
        body: JSON.stringify({ title, body, head, base: targetBase }),
      });
      return { content: [{ type: "text", text: "PR #" + pr.number + " created against " + targetBase + ": " + pr.html_url }] };
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
