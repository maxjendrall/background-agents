import { GitHubClient } from "./client.mjs";

export function githubExtension() {
  return {
    id: "github",
    description: "GitHub App integration, repo cloning, and PR tools",

    routes(app, { config }) {
      app.get("/api/github/status", async (c) => {
        const gh = new GitHubClient(config);
        if (!gh.configured) return c.json({ connected: false, reason: "GitHub App not configured" });
        try {
          const repos = await gh.listRepos();
          return c.json({ connected: true, appId: gh.appId, installationId: gh.installationId, repos: repos.map((r) => r.full_name) });
        } catch (e) {
          return c.json({ connected: false, error: e.message });
        }
      });
    },

    toolkits() { return []; },
  };
}
