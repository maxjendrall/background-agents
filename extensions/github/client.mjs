import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSign } from "node:crypto";
import { fetchJson } from "../../src/core/http.mjs";

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function generateJwt(appId, pemPath) {
  const pem = readFileSync(pemPath);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ iss: String(appId), iat: now - 60, exp: now + 540 }));
  const sig = base64url(createSign("RSA-SHA256").update(`${header}.${payload}`).sign(pem));
  return `${header}.${payload}.${sig}`;
}

export class GitHubClient {
  constructor(config) {
    this.config = config;
    this._installationToken = null;
    this._tokenExpiresAt = 0;
  }

  get appId() { return this.config.github?.app?.appId || ""; }
  get installationId() { return this.config.github?.app?.installationId || ""; }
  get pemPath() { return this.config.github?.app?.pemPath || ""; }
  get configured() { return Boolean(this.appId && this.installationId && this.pemPath && existsSync(this.pemPath)); }

  async getInstallationToken() {
    // Reuse if still valid (5 min buffer)
    if (this._installationToken && Date.now() < this._tokenExpiresAt - 5 * 60_000) {
      return this._installationToken;
    }

    const jwt = generateJwt(this.appId, this.pemPath);
    const res = await fetchJson(`https://api.github.com/app/installations/${this.installationId}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
    });

    if (!res.token) throw new Error("GitHub App token exchange failed: " + JSON.stringify(res));
    this._installationToken = res.token;
    this._tokenExpiresAt = new Date(res.expires_at).getTime();
    console.log("[github] installation token refreshed, expires:", res.expires_at);
    return this._installationToken;
  }

  async req(path, opts = {}) {
    const token = await this.getInstallationToken();
    return fetchJson(`https://api.github.com${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", ...opts.headers },
    });
  }

  async listRepos({ query, perPage = 30 } = {}) {
    // Installation repos endpoint
    const res = await this.req(`/installation/repositories?per_page=${perPage}`);
    const repos = res.repositories || [];
    if (query) {
      const q = query.toLowerCase();
      return repos.filter((r) => r.full_name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q));
    }
    return repos;
  }

  async getRepo(owner, repo) { return this.req(`/repos/${owner}/${repo}`); }

  async createPullRequest({ owner, repo, title, body, head, base }) {
    return this.req(`/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, body, head, base: base || this.config.github?.defaultBase || "main" }),
    });
  }

  async commentPullRequest({ owner, repo, number, body }) {
    return this.req(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }
}

export function parseGitHubRepo(input) {
  const s = String(input || "").trim();
  let m = s.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (m) return { owner: m[1], repo: m[2] };
  m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}
