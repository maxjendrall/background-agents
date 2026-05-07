import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

function bool(name, fallback = false) {
  const v = process.env[name];
  if (!v) return fallback;
  return ["1", "true", "yes"].includes(v.toLowerCase());
}

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function list(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function rel(base, value) {
  if (!value) return "";
  return isAbsolute(value) ? value : resolve(base, value);
}

export async function loadConfig() {
  const root = process.cwd();
  const dataDir = rel(root, process.env.DATA_DIR || ".data");
  const workspacePath = process.env.WORKSPACE_PATH ? rel(root, process.env.WORKSPACE_PATH) : "";

  await mkdir(dataDir, { recursive: true });
  await mkdir(resolve(dataDir, "jobs"), { recursive: true });
  await mkdir(resolve(dataDir, "repo-cache"), { recursive: true });
  await mkdir(resolve(dataDir, "workspaces"), { recursive: true });

  return {
    root,
    server: {
      host: process.env.HOST || "127.0.0.1",
      port: int("PORT", 8787),
      token: process.env.AUTH_TOKEN || "",
      publicUrl: process.env.PUBLIC_URL || "",
    },
    runtime: {
      model: process.env.AGENT_MODEL || "claude-sonnet-4-6",
      thinkingLevel: process.env.AGENT_THINKING || "xhigh",
      maxConcurrency: int("MAX_CONCURRENCY", 10),
      agentSpawnLimit: int("AGENT_SPAWN_LIMIT", 25),
      agentBootConcurrency: int("AGENT_BOOT_CONCURRENCY", 10),
      agentBootTimeoutMs: int("AGENT_BOOT_TIMEOUT_MS", 45_000),
      agentBootRetries: int("AGENT_BOOT_RETRIES", 3),
      mode: process.env.RUNTIME || "agentos", // "agentos" or "direct"
    },
    workspace: {
      path: workspacePath,
      exists: Boolean(workspacePath && existsSync(workspacePath)),
      readOnly: bool("WORKSPACE_READ_ONLY"),
      mountPath: "/workspace",
    },
    paths: {
      data: dataDir,
      jobs: resolve(dataDir, "jobs"),
      repoCache: resolve(dataDir, "repo-cache"),
      workspaces: resolve(dataDir, "workspaces"),
    },
    jira: {
      baseUrl: process.env.JIRA_BASE_URL || "",
      email: process.env.JIRA_EMAIL || "",
      token: process.env.JIRA_API_TOKEN || "",
      autoComment: bool("JIRA_AUTO_COMMENT"),
      triggerMention: process.env.JIRA_TRIGGER_MENTION || "@agent",
      triggerStatuses: list(process.env.JIRA_TRIGGER_STATUSES),
      triggerLabels: list(process.env.JIRA_TRIGGER_LABELS),
      oauth: {
        clientId: process.env.JIRA_OAUTH_CLIENT_ID || "",
        clientSecret: process.env.JIRA_OAUTH_CLIENT_SECRET || "",
      },
    },
    github: {
      token: process.env.GITHUB_TOKEN || "",
      defaultOwner: process.env.GITHUB_DEFAULT_OWNER || "",
      defaultBase: process.env.GITHUB_DEFAULT_BASE || "main",
      allowPush: bool("GIT_ALLOW_PUSH"),
      allowPr: bool("GITHUB_ALLOW_PR"),
      oauth: {
        clientId: process.env.GITHUB_OAUTH_CLIENT_ID || "",
        clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || "",
      },
      repos: list(process.env.GITHUB_REPOS || ""),  // e.g. "owner/repo1,owner/repo2"
      app: {
        appId: process.env.GITHUB_APP_ID || "",
        installationId: process.env.GITHUB_INSTALLATION_ID || "",
        pemPath: process.env.GITHUB_APP_PEM_PATH || "/root/.github-app/private-key.pem",
      },
    },
    browser: {
      headless: bool("BROWSER_HEADLESS", true),
    },
    figma: {
      personalAccessToken: process.env.FIGMA_PERSONAL_ACCESS_TOKEN || "",
      teamId: process.env.FIGMA_TEAM_ID || "",
      outputDir: process.env.FIGMA_OUTPUT_DIR || "figma-assets",
    },
    contentful: {
      spaceId: process.env.CONTENTFUL_SPACE_ID || "",
      environment: process.env.CONTENTFUL_ENVIRONMENT || "staging",
      managementToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN || "",
      deliveryToken: process.env.CONTENTFUL_DELIVERY_TOKEN || "",
      previewToken: process.env.CONTENTFUL_PREVIEW_TOKEN || "",
    },
  };
}
