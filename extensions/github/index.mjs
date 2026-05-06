import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { fetchJson } from "../../src/core/http.mjs";

class GitHub {
  constructor(config) { this.config = config; }
  get ok() { return Boolean(this.config.github.token); }
  req(path, opts = {}) {
    if (!this.ok) throw new Error("GITHUB_TOKEN not set");
    return fetchJson(`https://api.github.com${path}`, { ...opts, headers: { Authorization: `Bearer ${this.config.github.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", ...opts.headers } });
  }
  listRepos(query, perPage = 50) {
    if (query) { const q = this.config.github.defaultOwner ? `${query} org:${this.config.github.defaultOwner}` : query; return this.req(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${perPage}`); }
    return this.req(`/user/repos?per_page=${perPage}&sort=updated`);
  }
  getRepo(owner, repo) { return this.req(`/repos/${owner}/${repo}`); }
  createPr({ owner, repo, title, body, head, base }) {
    if (!this.config.github.allowPr) throw new Error("PR creation disabled");
    return this.req(`/repos/${owner}/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title, body, head, base: base || this.config.github.defaultBase }) });
  }
  commentPr({ owner, repo, number, body }) { return this.req(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) }); }
}

export function githubExtension() {
  return {
    id: "github",
    description: "GitHub repo discovery and PR tools",
    toolkits({ config }) {
      const gh = new GitHub(config);
      return [toolKit({
        name: "github",
        description: "GitHub tools",
        tools: {
          list_repos: hostTool({ description: "List/search repos.", inputSchema: z.object({ query: z.string().optional(), perPage: z.number().default(50) }), execute: ({ query, perPage }) => gh.listRepos(query, perPage) }),
          get_repo: hostTool({ description: "Get repo metadata.", inputSchema: z.object({ owner: z.string(), repo: z.string() }), execute: ({ owner, repo }) => gh.getRepo(owner, repo) }),
          create_pr: hostTool({ description: "Open a PR.", inputSchema: z.object({ owner: z.string(), repo: z.string(), title: z.string(), body: z.string(), head: z.string(), base: z.string().optional() }), execute: (i) => gh.createPr(i) }),
          comment_pr: hostTool({ description: "Comment on PR.", inputSchema: z.object({ owner: z.string(), repo: z.string(), number: z.number(), body: z.string() }), execute: (i) => gh.commentPr(i) }),
        },
      })];
    },
  };
}

export function parseGitHubRepo(input) {
  const s = String(input || "").trim();
  let m = s.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (m) return { owner: m[1], repo: m[2] };
  m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}
