import { GitHubClient } from "./client.mjs";
import { RepoCache } from "./repo-cache.mjs";

export function githubExtension() {
  return {
    id: "github",
    description: "GitHub OAuth, repo cloning, and PR tools",

    routes(app, { config }) {
      // --- OAuth routes ---

      app.get("/api/github/oauth/authorize", (c) => {
        const oauth = config.github?.oauth;
        if (!oauth?.clientId) return c.json({ error: "GITHUB_OAUTH_CLIENT_ID not configured" }, 400);
        const scopes = "repo read:org";
        const state = Math.random().toString(36).slice(2);
        const callbackUrl = `${c.req.header("x-forwarded-proto") || "http"}://${c.req.header("host")}/api/github/oauth/callback`;
        const url = `https://github.com/login/oauth/authorize?client_id=${oauth.clientId}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}`;
        return c.redirect(url);
      });

      app.get("/api/github/oauth/callback", async (c) => {
        const code = c.req.query("code");
        if (!code) return c.json({ error: "No authorization code" }, 400);
        const gh = new GitHubClient(config);
        try {
          const tokens = await gh.exchangeCode(code);
          // Fetch user info
          let user = null;
          try { user = await gh.req("/user"); } catch {}
          return c.html(`<h1>GitHub connected</h1><p>User: ${user?.login || "connected"}</p><p>Scopes: ${tokens.scope}</p><p><a href="/ui">Back to dashboard</a></p>`);
        } catch (e) {
          return c.json({ error: e.message }, 500);
        }
      });

      app.get("/api/github/oauth/status", async (c) => {
        const gh = new GitHubClient(config);
        if (!gh.configured) return c.json({ connected: false });
        const token = gh.getAccessToken();
        if (!token) return c.json({ connected: false, mode: "oauth", needsAuth: true });
        try {
          const user = await gh.req("/user");
          return c.json({ connected: true, user: user.login, scopes: gh._loadTokens()?.scope || "pat" });
        } catch {
          return c.json({ connected: false, mode: "oauth", needsAuth: true });
        }
      });
    },

    // No Agent OS host toolkits needed — git/github tools are Pi native extensions
    toolkits() { return []; },
  };
}
