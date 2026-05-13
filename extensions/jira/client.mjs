import { basicAuth, fetchJson } from "../../src/core/http.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

function safeName(name) {
  return basename(String(name || "attachment")).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "attachment";
}

function doc(text) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function boardId(input) {
  const match = String(input || "").match(/(?:^|\/)board\/(\d+)$|^(\d+)$/);
  return match ? (match[1] || match[2]) : "";
}

function combineJql(baseJql, extraJql) {
  if (!extraJql?.trim()) return baseJql;
  return `(${baseJql}) AND (${extraJql})`;
}

function normalizedAuthMode(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

export class JiraClient {
  constructor(config) {
    this.config = config;
    this._tokenCache = null;
  }

  get mode() {
    const explicit = normalizedAuthMode(this.config.jira.authMode);
    if (["service-account", "service", "scoped-token", "scoped", "gateway"].includes(explicit)) return "scoped-token";
    if (explicit === "oauth") return this.config.jira.oauth?.clientId ? "oauth" : "none";
    if (explicit === "basic") return this.config.jira.email && this.config.jira.token ? "basic" : "none";
    if (this.config.jira.cloudId && this.config.jira.token) return "scoped-token";
    if (this.config.jira.oauth?.clientId) return "oauth";
    if (this.config.jira.email && this.config.jira.token) return "basic";
    return "none";
  }

  get configured() { return this.mode !== "none"; }

  // --- OAuth token management ---

  _tokenPath() { return resolve(this.config.paths.data, "jira-oauth-tokens.json"); }

  _loadTokens() {
    if (this._tokenCache) return this._tokenCache;
    const p = this._tokenPath();
    if (!existsSync(p)) return null;
    try { this._tokenCache = JSON.parse(readFileSync(p, "utf8")); return this._tokenCache; } catch { return null; }
  }

  _saveTokens(tokens) {
    this._tokenCache = tokens;
    writeFileSync(this._tokenPath(), JSON.stringify(tokens, null, 2));
  }

  async _getOAuthAccessToken() {
    const tokens = this._loadTokens();
    if (!tokens?.refresh_token) throw new Error("Jira OAuth not authorized. Visit /api/jira/oauth/authorize in a browser.");

    // Check if access token is still valid (with 60s buffer)
    if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60_000) {
      return tokens.access_token;
    }

    // Refresh
    const res = await fetchJson("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.config.jira.oauth.clientId,
        client_secret: this.config.jira.oauth.clientSecret,
        refresh_token: tokens.refresh_token,
      }),
    });

    const updated = {
      ...tokens,
      access_token: res.access_token,
      expires_at: Date.now() + (res.expires_in || 3600) * 1000,
      ...(res.refresh_token ? { refresh_token: res.refresh_token } : {}),
    };
    this._saveTokens(updated);
    return updated.access_token;
  }

  async _getCloudId() {
    if (this.config.jira.cloudId) return this.config.jira.cloudId;
    const tokens = this._loadTokens();
    if (tokens?.cloudId) return tokens.cloudId;

    const accessToken = await this._getOAuthAccessToken();
    const resources = await fetchJson("https://api.atlassian.com/oauth/token/accessible-resources", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });

    if (!resources.length) throw new Error("No Jira sites accessible. Check app permissions.");
    const cloudId = resources[0].id;

    this._saveTokens({ ...this._loadTokens(), cloudId, siteName: resources[0].name, siteUrl: resources[0].url });
    return cloudId;
  }

  // --- Exchange auth code for tokens (called from OAuth callback) ---

  async exchangeCode(code, redirectUri) {
    const res = await fetchJson("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: this.config.jira.oauth.clientId,
        client_secret: this.config.jira.oauth.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    this._saveTokens({
      access_token: res.access_token,
      refresh_token: res.refresh_token,
      expires_at: Date.now() + (res.expires_in || 3600) * 1000,
      scope: res.scope,
    });

    // Fetch and store cloud ID
    await this._getCloudId();
    return this._loadTokens();
  }

  // --- API requests ---

  _scopedTokenUrl(path) {
    const cloudId = this.config.jira.cloudId;
    if (!cloudId) throw new Error("JIRA_CLOUD_ID is required for Jira service-account/scoped-token auth. Scoped tokens must call https://api.atlassian.com/ex/jira/{cloudId}/...");
    return `https://api.atlassian.com/ex/jira/${cloudId}${path}`;
  }

  async reqRaw(path, opts = {}) {
    if (this.mode === "basic") {
      return fetch(`${this.config.jira.baseUrl.replace(/\/$/, "")}${path}`, {
        ...opts,
        headers: { Authorization: basicAuth(this.config.jira.email, this.config.jira.token), Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}), ...opts.headers },
      });
    }

    if (this.mode === "scoped-token") {
      return fetch(this._scopedTokenUrl(path), {
        ...opts,
        headers: { Authorization: `Bearer ${this.config.jira.token}`, Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}), ...opts.headers },
      });
    }

    if (this.mode === "oauth") {
      const accessToken = await this._getOAuthAccessToken();
      const cloudId = await this._getCloudId();
      return fetch(`https://api.atlassian.com/ex/jira/${cloudId}${path}`, {
        ...opts,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}), ...opts.headers },
      });
    }

    throw new Error("Jira not configured");
  }

  async req(path, opts = {}) {
    if (this.mode === "basic") {
      return fetchJson(`${this.config.jira.baseUrl.replace(/\/$/, "")}${path}`, {
        ...opts,
        headers: { Authorization: basicAuth(this.config.jira.email, this.config.jira.token), Accept: "application/json", "Content-Type": "application/json", ...opts.headers },
      });
    }

    if (this.mode === "scoped-token") {
      return fetchJson(this._scopedTokenUrl(path), {
        ...opts,
        headers: { Authorization: `Bearer ${this.config.jira.token}`, Accept: "application/json", "Content-Type": "application/json", ...opts.headers },
      });
    }

    if (this.mode === "oauth") {
      const accessToken = await this._getOAuthAccessToken();
      const cloudId = await this._getCloudId();
      return fetchJson(`https://api.atlassian.com/ex/jira/${cloudId}${path}`, {
        ...opts,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json", ...opts.headers },
      });
    }

    throw new Error("Jira not configured");
  }

  getIssue(key) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}?expand=renderedFields`); }
  async getBoardConfiguration(board) {
    const id = boardId(board);
    if (!id) throw new Error("board id required, e.g. 3 or /board/3");
    return this.req(`/rest/agile/1.0/board/${encodeURIComponent(id)}/configuration`);
  }
  async getFilter(filterId) { return this.req(`/rest/api/3/filter/${encodeURIComponent(filterId)}`); }
  async getBoardJql(board) {
    const id = boardId(board);
    if (!id) throw new Error("board id required, e.g. 3 or /board/3");
    let config;
    try {
      config = await this.getBoardConfiguration(id);
    } catch (e) {
      if (String(e.message || e).includes("scope does not match")) {
        throw new Error("Jira board API scope is missing. For OAuth, re-authorize at /api/jira/oauth/authorize. For service-account/scoped-token auth, create a new token with read:board-scope:jira-software, read:project:jira, read:filter:jira, and read:jql:jira.");
      }
      throw e;
    }
    const filterId = config.filter?.id;
    if (!filterId) throw new Error(`Board ${id} does not expose a filter id`);
    const filter = await this.getFilter(filterId);
    if (!filter.jql) throw new Error(`Filter ${filterId} for board ${id} has no JQL`);
    return { boardId: id, filterId, filterName: filter.name || config.filter?.name || null, jql: filter.jql };
  }
  async listAttachments(key) {
    const issue = await this.getIssue(key);
    return { issueKey: key, attachments: issue.fields?.attachment || [] };
  }
  async getAttachment(id) { return this.req(`/rest/api/3/attachment/${encodeURIComponent(id)}`); }
  async downloadAttachment(id, outDir) {
    const meta = await this.getAttachment(id);
    await mkdir(outDir, { recursive: true });
    const filename = `${id}-${safeName(meta.filename)}`;
    const outPath = resolve(outDir, filename);
    const res = await this.reqRaw(`/rest/api/3/attachment/content/${encodeURIComponent(id)}`, { headers: { Accept: "*/*" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buf);
    return { id, filename: meta.filename, mimeType: meta.mimeType, size: buf.length, path: outPath };
  }
  getComments(key) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=20`); }
  search(jql, max = 10, fields = ["summary", "status", "assignee", "priority"]) { return this.req("/rest/api/3/search/jql", { method: "POST", body: JSON.stringify({ jql, maxResults: max, fields }) }); }
  async searchBoard(board, jql = "", max = 10, fields = ["summary", "status", "assignee", "priority"]) {
    const boardFilter = await this.getBoardJql(board);
    const effectiveJql = combineJql(boardFilter.jql, jql);
    const result = await this.search(effectiveJql, max, fields);
    return { ...result, board: boardFilter, jql: effectiveJql };
  }
  async countJql(jql) {
    try {
      const result = await this.req("/rest/api/3/search/approximate-count", { method: "POST", body: JSON.stringify({ jql }) });
      return { jql, count: result.count || 0, approximate: true };
    } catch (e) {
      // Some Jira installations/scopes may not expose approximate-count; fall back to the classic search total.
      const result = await this.req("/rest/api/3/search", { method: "POST", body: JSON.stringify({ jql, maxResults: 0, fields: [] }) });
      return { jql, count: result.total || 0, approximate: false };
    }
  }
  async countBoard(board, jql = "") {
    const boardFilter = await this.getBoardJql(board);
    return { ...(await this.countJql(combineJql(boardFilter.jql, jql))), board: boardFilter };
  }
  addComment(key, text) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: "POST", body: JSON.stringify({ body: doc(text) }) }); }
  listTransitions(key) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`); }
  transitionIssue(key, id) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id } }) }); }
}
