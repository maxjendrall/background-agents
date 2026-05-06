import { basicAuth, fetchJson } from "../../src/core/http.mjs";

function doc(text) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

export class JiraClient {
  constructor(config) { this.config = config; }

  get configured() { return Boolean(this.config.jira.baseUrl && this.config.jira.email && this.config.jira.token); }

  req(path, opts = {}) {
    if (!this.configured) throw new Error("Jira not configured");
    return fetchJson(`${this.config.jira.baseUrl.replace(/\/$/, "")}${path}`, {
      ...opts,
      headers: { Authorization: basicAuth(this.config.jira.email, this.config.jira.token), Accept: "application/json", "Content-Type": "application/json", ...opts.headers },
    });
  }

  getIssue(key) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}?expand=renderedFields`); }
  getComments(key) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=20`); }
  search(jql, max = 10) { return this.req("/rest/api/3/search", { method: "POST", body: JSON.stringify({ jql, maxResults: max, fields: ["summary", "status", "assignee", "priority"] }) }); }
  addComment(key, text) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: "POST", body: JSON.stringify({ body: doc(text) }) }); }
  listTransitions(key) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`); }
  transitionIssue(key, id) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id } }) }); }
}
