import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fetchJson } from "../../src/core/http.mjs";

export class GitHubClient {
  constructor(config) {
    this.config = config;
    this._tokenCache = null;
  }

  get configured() { return Boolean(this.config.github?.oauth?.clientId) || Boolean(this.config.github?.token); }

  // --- Token management ---

  _tokenPath() { return resolve(this.config.paths.data, "github-oauth-tokens.json"); }

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

  getAccessToken() {
    // Personal access token from env
    if (this.config.github?.token) return this.config.github.token;
    // OAuth token
    const tokens = this._loadTokens();
    return tokens?.access_token || null;
  }

  async exchangeCode(code) {
    const res = await fetchJson("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.github.oauth.clientId,
        client_secret: this.config.github.oauth.clientSecret,
        code,
      }),
    });
    if (res.error) throw new Error(`GitHub OAuth error: ${res.error_description || res.error}`);
    this._saveTokens({ access_token: res.access_token, scope: res.scope, token_type: res.token_type });
    return this._loadTokens();
  }

  // --- API ---

  async req(path, opts = {}) {
    const token = this.getAccessToken();
    if (!token) throw new Error("GitHub not authenticated. Visit /api/github/oauth/authorize");
    return fetchJson(`https://api.github.com${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", ...opts.headers },
    });
  }

  async listRepos({ query, perPage = 30 } = {}) {
    if (query) {
      const owner = this.config.github.defaultOwner;
      const q = owner ? `${query} org:${owner}` : query;
      return this.req(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${perPage}`);
    }
    return this.req(`/user/repos?per_page=${perPage}&sort=updated&type=all`);
  }

  async getRepo(owner, repo) { return this.req(`/repos/${owner}/${repo}`); }

  async createPullRequest({ owner, repo, title, body, head, base }) {
    return this.req(`/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, body, head, base: base || this.config.github.defaultBase || "main" }),
    });
  }

  async commentPullRequest({ owner, repo, number, body }) {
    return this.req(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }
}
