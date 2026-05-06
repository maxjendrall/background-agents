import { basicAuth, fetchJson } from "../../src/core/http.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function doc(text) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

export class JiraClient {
  constructor(config) {
    this.config = config;
    this._tokenCache = null;
  }

  get mode() {
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

  async req(path, opts = {}) {
    if (this.mode === "basic") {
      return fetchJson(`${this.config.jira.baseUrl.replace(/\/$/, "")}${path}`, {
        ...opts,
        headers: { Authorization: basicAuth(this.config.jira.email, this.config.jira.token), Accept: "application/json", "Content-Type": "application/json", ...opts.headers },
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
  getComments(key) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=20`); }
  search(jql, max = 10) { return this.req("/rest/api/3/search/jql", { method: "POST", body: JSON.stringify({ jql, maxResults: max, fields: ["summary", "status", "assignee", "priority"] }) }); }
  addComment(key, text) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: "POST", body: JSON.stringify({ body: doc(text) }) }); }
  listTransitions(key) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`); }
  transitionIssue(key, id) { return this.req(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id } }) }); }
}
