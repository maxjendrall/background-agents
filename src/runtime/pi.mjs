import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { AgentOs, createHostDirBackend } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import { collectToolkits } from "../core/extension.mjs";
import { systemPrompt } from "../agents/default.mjs";
import { piJiraExtensionSource } from "./pi-jira-extension.mjs";
import { piGitHubExtensionSource } from "./pi-github-extension.mjs";
import { piGitExtensionSource } from "./pi-git-extension.mjs";
import { piFigmaExtensionSource } from "./pi-figma-extension.mjs";
import { piViewExtensionSource } from "./pi-view-extension.mjs";
import { piFilesExtensionSource } from "./pi-files-extension.mjs";
import { piContentfulExtensionSource } from "./pi-contentful-extension.mjs";
import { RepoCache } from "../../extensions/github/repo-cache.mjs";
import { trim } from "../core/redact.mjs";

// Direct Pi SDK imports for fallback runtime
import { createAgentSession, SessionManager, DefaultResourceLoader, AuthStorage, ModelRegistry, getAgentDir, codingTools, createGrepTool, createFindTool, createLsTool } from "@mariozechner/pi-coding-agent";

const VM_HOME = "/home/user";
const VM_WORKSPACE = "/home/user/workspace";

function effectiveThinkingLevel(job, config) {
  return job.thinkingLevel || job.thinking || config.runtime.thinkingLevel || "xhigh";
}

// --- Event extractors (ACP format from Agent OS) ---
function acpText(event) {
  const u = event?.params?.update;
  if (u?.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") return u.content.text;
  return "";
}
function acpThinking(event) {
  const u = event?.params?.update;
  if (u?.sessionUpdate === "agent_thought_chunk" && typeof u.content?.text === "string") return u.content.text;
  return "";
}
function acpToolCall(event) {
  const u = event?.params?.update;
  if (!u) return null;
  if (u.sessionUpdate === "tool_call") return { type: "tool_start", id: u.toolCallId, name: u.title, status: u.status, input: u.rawInput, locations: u.locations };
  if (u.sessionUpdate === "tool_call_update") {
    // Skip noisy pending updates that carry no useful data
    if (u.status === "pending" && !u.rawInput && !u.rawOutput && !u.content) return null;
    return { type: "tool_update", id: u.toolCallId, status: u.status, rawInput: u.rawInput, output: u.rawOutput, content: u.content, locations: u.locations };
  }
  return null;
}

async function cloneWorkspace(srcPath, dstPath) {
  const { execSync } = await import("node:child_process");
  if (existsSync(resolve(srcPath, ".git"))) {
    const branch = `agent/${Date.now()}`;
    try { execSync("git worktree prune", { cwd: srcPath, stdio: "ignore" }); } catch {}
    execSync(`git worktree add -B "${branch}" "${dstPath}" HEAD`, { cwd: srcPath, stdio: "ignore", timeout: 60_000 });
    return { method: "worktree", branch };
  }
  await mkdir(dstPath, { recursive: true });
  execSync(`rsync -a --exclude='node_modules' --exclude='.git' --exclude='.data' --exclude='.next' --exclude='dist' "${srcPath}/" "${dstPath}/"`, { stdio: "ignore", timeout: 120_000 });
  return { method: "copy" };
}

// --- Live session for follow-ups ---
class LiveSession {
  constructor({ vm, piSession, sessionId, unsub, runtime, model, thinkingLevel }) {
    this.vm = vm;
    this.piSession = piSession;
    this.sessionId = sessionId;
    this.unsub = unsub;
    this.runtime = runtime;
    this.model = model;
    this.thinkingLevel = thinkingLevel;
    this.lastActivity = Date.now();
    this.onEvent = null; // current event callback, updated on follow-up
  }
  async prompt(text, mode = "follow_up") {
    this.lastActivity = Date.now();
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (this.vm) return this.vm.prompt(this.sessionId, text, { streamingBehavior });
    if (this.piSession) {
      if (this.piSession.isStreaming) await this.piSession.prompt(text, { streamingBehavior });
      else await this.piSession.prompt(text);
      return { text: "" };
    }
  }
  dispose() {
    this.unsub?.();
    if (this.vm) { try { this.vm.closeSession(this.sessionId); } catch {} this.vm.dispose().catch(() => {}); }
  }
}

export class PiRuntime {
  constructor({ config, extensions, processes }) {
    this.config = config;
    this.extensions = extensions;
    this.processes = processes;
    this.sessions = new Map();
    this._reaper = setInterval(() => this._reapIdle(), 5 * 60_000);
    // "agentos" or "direct"
    this.mode = config.runtime.mode || "agentos";
  }

  _reapIdle() {
    const maxIdle = 30 * 60_000;
    for (const [id, s] of this.sessions) {
      if (Date.now() - s.lastActivity > maxIdle) { console.log("[pi] reaping:", id); s.dispose(); this.sessions.delete(id); }
    }
  }

  _loadJiraTokens() {
    const p = resolve(this.config.paths.data, "jira-oauth-tokens.json");
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  }

  async _refreshJiraAccessToken(tokens) {
    // If token is still fresh (more than 5 min left), reuse it
    if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 5 * 60_000) {
      return tokens.access_token;
    }
    const clientId = this.config.jira.oauth?.clientId;
    const clientSecret = this.config.jira.oauth?.clientSecret;
    if (!clientId || !tokens.refresh_token) throw new Error("Jira OAuth not configured for refresh");
    const res = await fetch("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error("Jira token refresh failed: " + JSON.stringify(data));
    const updated = { ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000, ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}) };
    // Persist updated tokens
    const p = resolve(this.config.paths.data, "jira-oauth-tokens.json");
    try { writeFileSync(p, JSON.stringify(updated, null, 2)); } catch {}
    return updated.access_token;
  }

  async run(job, { onEvent }) {
    // Live session exists → reuse it (same Pi conversation history)
    if (this.sessions.has(job.id)) return this._followUp(job, onEvent);
    // Completed/interrupted jobs followed up after a restart can hang when
    // AgentOS tries to resurrect an older Pi JSONL session. For those, prefer
    // context injection into a fresh AgentOS session when requested by the job.
    if (job.resumeStrategy === "context") {
      return this._resumeWithContext(job, onEvent, { freshAgentOsSession: true });
    }
    // No live session but has a persisted Pi session file/dir → resume from disk.
    if (job.piSessionFile && existsSync(job.piSessionFile)) {
      console.log("[pi] resuming from persisted session:", job.piSessionFile);
      return this._resumeFromDisk(job, onEvent);
    }
    if (this.mode === "agentos" && job.piSessionDir && existsSync(job.piSessionDir)) {
      console.log("[pi:agentos] resuming from persisted session dir:", job.piSessionDir);
      return this._startAgentOs(job, onEvent);
    }
    // No live session, no persisted file, but has previous output → inject context
    if (job.output || job.result) {
      return this._resumeWithContext(job, onEvent);
    }
    if (this.mode === "direct") return this._startDirect(job, onEvent);
    return this._startAgentOs(job, onEvent);
  }

  async _followUp(job, onEvent) {
    const live = this.sessions.get(job.id);
    const nextModel = job.model || this.config.runtime.model;
    const nextThinkingLevel = effectiveThinkingLevel(job, this.config);
    if ((live.model && live.model !== nextModel) || (live.thinkingLevel && live.thinkingLevel !== nextThinkingLevel)) {
      console.log("[pi] switching session config:", live.model, live.thinkingLevel, "->", nextModel, nextThinkingLevel);
      await onEvent("agent.session_switch", {
        from: { sessionId: live.sessionId, model: live.model, thinkingLevel: live.thinkingLevel },
        to: { model: nextModel, thinkingLevel: nextThinkingLevel },
      });
      live.dispose();
      this.sessions.delete(job.id);
      return this._resumeWithContext(job, onEvent);
    }
    console.log("[pi] follow-up:", live.sessionId);
    live.onEvent = onEvent;
    const messageMode = job.messageMode || "follow_up";
    await onEvent("agent.follow_up", { sessionId: live.sessionId, model: live.model, thinkingLevel: live.thinkingLevel, messageMode });
    await live.prompt(job.prompt, messageMode);
    console.log("[pi] follow-up done");
    return { sessionId: live.sessionId, text: "" };
  }

  async _resumeFromDisk(job, onEvent) {
    // Resume a Pi session from its persisted JSONL file — full conversation history.
    if (this.mode === "direct") return this._startDirect(job, onEvent);
    // Agent OS can't use file-backed sessions, fall through to context injection
    return this._resumeWithContext(job, onEvent);
  }

  async _resumeWithContext(job, onEvent, opts = {}) {
    // Inject previous conversation output as context prefix for the new session
    const prevOutput = job.output || job.result || "";
    const contextPrefix = prevOutput
      ? `[CONTEXT] You are continuing a previous session. The workspace has been refreshed with your repos. Your previous changes in git worktrees are preserved.\n\nPrevious conversation:\n${trim(prevOutput, 15_000)}\n\n[NEW MESSAGE] `
      : "";
    const originalPrompt = job.prompt;
    const originalSessionDir = job.piSessionDir;
    job.prompt = contextPrefix + job.prompt;
    if (opts.freshAgentOsSession && this.mode === "agentos") {
      job.piSessionDir = resolve(job.workspacePath, `.pi-sessions-context-${Date.now()}`);
    }
    let result;
    try {
      if (this.mode === "direct") result = await this._startDirect(job, onEvent);
      else result = await this._startAgentOs(job, onEvent);
    } finally {
      job.prompt = originalPrompt;
      if (!opts.freshAgentOsSession) job.piSessionDir = originalSessionDir;
    }
    return result;
  }

  // ── Agent OS runtime ─────────────────────────────────────────
  async _startAgentOs(job, onEvent) {
    const jobDir = job.workspacePath;
    await mkdir(jobDir, { recursive: true });
    job.piSessionDir = job.piSessionDir || resolve(jobDir, ".pi-sessions");
    job.figmaArtifactsDir = job.figmaArtifactsDir || resolve(jobDir, "figma-artifacts");
    job.jiraArtifactsDir = job.jiraArtifactsDir || resolve(jobDir, "jira-artifacts");
    job.contentfulArtifactsDir = job.contentfulArtifactsDir || resolve(jobDir, "contentful-artifacts");
    await mkdir(job.piSessionDir, { recursive: true });
    await mkdir(job.figmaArtifactsDir, { recursive: true });
    await mkdir(job.jiraArtifactsDir, { recursive: true });
    await mkdir(job.contentfulArtifactsDir, { recursive: true });

    // Clone configured repos into per-job worktrees
    let repoToken = null;
    try {
      const { GitHubClient: GHC } = await import("../../extensions/github/client.mjs");
      const gh = new GHC(this.config);
      if (gh.configured) repoToken = await gh.getInstallationToken();
    } catch {}
    const repoCache = new RepoCache(this.config, repoToken);
    const mountedRepos = [];
    const configuredRepos = this.config.github?.repos || [];

    if (configuredRepos.length) {
      await onEvent("job.cloning_repos", { repos: configuredRepos });
      for (const repoSpec of configuredRepos) {
        const [owner, repo] = repoSpec.split("/");
        if (!owner || !repo) continue;
        try {
          const wt = await repoCache.createWorktree(owner, repo, job.id, jobDir);
          mountedRepos.push(wt);
          console.log(`[pi:agentos] repo ${owner}/${repo} -> ${wt.hostPath} branch: ${wt.branch}`);
        } catch (e) {
          console.log(`[pi:agentos] failed to clone ${repoSpec}:`, e.message.slice(0, 200));
          await onEvent("job.clone_failed", { repo: repoSpec, error: e.message.slice(0, 200) });
        }
      }
      await onEvent("job.repos_ready", { repos: mountedRepos.map((r) => ({ path: r.agentPath, branch: r.branch })) });
    } else if (this.config.workspace.exists) {
      // Fallback: clone WORKSPACE_PATH if no repos configured
      const jobRepoDir = resolve(jobDir, "repo");
      if (!existsSync(jobRepoDir)) {
        await onEvent("job.cloning", { src: this.config.workspace.path });
        const result = await cloneWorkspace(this.config.workspace.path, jobRepoDir);
        await onEvent("job.cloned", result);
      }
      if (existsSync(jobRepoDir)) mountedRepos.push({ hostPath: jobRepoDir, agentPath: VM_WORKSPACE, branch: null });
    }

    const model = job.model || this.config.runtime.model;
    const thinkingLevel = effectiveThinkingLevel(job, this.config);
    let defaultProvider = "openai-codex", defaultModel = "gpt-5.5";
    if (model?.includes("/")) [defaultProvider, defaultModel] = model.split("/", 2);
    else if (model) defaultModel = model;

    // Build mounts from cloned repos
    const mounts = [{
      path: `${VM_WORKSPACE}/.pi-sessions`,
      driver: createHostDirBackend({ hostPath: job.piSessionDir, readOnly: false }),
      readOnly: false,
    }, {
      path: `${VM_WORKSPACE}/figma-artifacts`,
      driver: createHostDirBackend({ hostPath: job.figmaArtifactsDir, readOnly: false }),
      readOnly: false,
    }, {
      // Back-compat for older Figma exports/instructions that used figma-assets.
      path: `${VM_WORKSPACE}/figma-assets`,
      driver: createHostDirBackend({ hostPath: job.figmaArtifactsDir, readOnly: false }),
      readOnly: false,
    }, {
      path: `${VM_WORKSPACE}/jira-artifacts`,
      driver: createHostDirBackend({ hostPath: job.jiraArtifactsDir, readOnly: false }),
      readOnly: false,
    }, {
      path: `${VM_WORKSPACE}/contentful-artifacts`,
      driver: createHostDirBackend({ hostPath: job.contentfulArtifactsDir, readOnly: false }),
      readOnly: false,
    }, {
      // Back-compat for the original Jira attachment downloader path.
      path: `${VM_WORKSPACE}/attachments`,
      driver: createHostDirBackend({ hostPath: job.jiraArtifactsDir, readOnly: false }),
      readOnly: false,
    }];
    if (mountedRepos.length > 0 && configuredRepos.length > 0) {
      // Mount the parent repos/ dir as a single mount so Pi's read tool can see all repos
      const reposHostDir = resolve(jobDir, "repos");
      mounts.push({
        path: "/home/user/workspace/repos",
        driver: createHostDirBackend({ hostPath: reposHostDir, readOnly: false }),
        readOnly: false,
      });
    } else if (mountedRepos.length === 1 && !configuredRepos.length) {
      // Single workspace mount (fallback mode)
      mounts.push({
        path: mountedRepos[0].agentPath,
        driver: createHostDirBackend({ hostPath: mountedRepos[0].hostPath, readOnly: false }),
        readOnly: false,
      });
    }

    const toolKits = collectToolkits({ config: this.config, job, processes: this.processes }, this.extensions);
    const vm = await AgentOs.create({ software: [common, pi], mounts, toolKits, additionalInstructions: systemPrompt(this.mode) });

    // Write agents.md into workspace
    await vm.mkdir(VM_WORKSPACE, { recursive: true });
    const agentsMdPath = resolve(this.config.root, "agents.md");
    if (existsSync(agentsMdPath)) {
      await vm.writeFile(`${VM_WORKSPACE}/agents.md`, readFileSync(agentsMdPath, "utf8"));
    } else {
      // Default agents.md
      const repoList = mountedRepos.map((r) => `- ${r.agentPath} (branch: ${r.branch || "default"})`).join("\n");
      await vm.writeFile(`${VM_WORKSPACE}/agents.md`, [
        "# Agent Workspace",
        "",
        "You are a background coding agent.",
        "",
        repoList ? `## Repositories\n${repoList}\n` : "",
        "## Workflow",
        "1. Read the task/ticket carefully",
        "2. Inspect the relevant code",
        "3. Make the smallest safe change",
        "4. Use git_commit to commit your changes",
        "5. Use git_push to push your branch",
        "6. Use gh_pr_create to open a pull request",
        "7. Report results on the Jira ticket if applicable",
      ].filter(Boolean).join("\n"));
    }

    // Write Pi config into VFS
    const piDir = `${VM_HOME}/.pi/agent`;
    await vm.mkdir(piDir, { recursive: true });

    // Auth: merge host auth.json with env var API keys
    let authData = {};
    try { authData = JSON.parse(readFileSync(resolve(homedir(), ".pi", "agent", "auth.json"), "utf8")); } catch {}
    if (process.env.OPENAI_API_KEY && !authData.openai) authData.openai = { type: "api_key", key: process.env.OPENAI_API_KEY };
    if (process.env.ANTHROPIC_API_KEY && !authData.anthropic) authData.anthropic = { type: "api_key", key: process.env.ANTHROPIC_API_KEY };
    await vm.writeFile(`${piDir}/auth.json`, JSON.stringify(authData, null, 2));

    // Models: copy from host if exists
    try { await vm.writeFile(`${piDir}/models.json`, readFileSync(resolve(homedir(), ".pi", "agent", "models.json"), "utf8")); } catch {}

    await vm.writeFile(`${piDir}/settings.json`, JSON.stringify({ defaultProvider, defaultModel, defaultThinkingLevel: thinkingLevel }, null, 2));
    await vm.mkdir(VM_WORKSPACE, { recursive: true });

    // Write Pi extensions into VFS so they load as native tools
    const extDir = `${VM_HOME}/.pi/agent/extensions`;
    await vm.mkdir(extDir, { recursive: true });

    // Jira extension: reads OAuth config from env vars
    await vm.writeFile(`${extDir}/jira-tools.js`, piJiraExtensionSource());

    // GitHub extension: git + GitHub API tools
    await vm.writeFile(`${extDir}/github-tools.js`, piGitHubExtensionSource());

    // Git extension: calls host toolkit via internal RPC
    await vm.writeFile(`${extDir}/git-tools.js`, piGitExtensionSource());

    // Figma extension: delegates to host Figma tools for heavy operations
    await vm.writeFile(`${extDir}/figma-tools.js`, piFigmaExtensionSource());

    // Generic viewer extension: return images as image attachments
    await vm.writeFile(`${extDir}/view-tools.js`, piViewExtensionSource());

    // Reliable filesystem inspection tools that avoid shell/brush quirks
    await vm.writeFile(`${extDir}/files-tools.js`, piFilesExtensionSource());

    // Contentful staging/data model inspection tools
    await vm.writeFile(`${extDir}/contentful-tools.js`, piContentfulExtensionSource());

    // Build Jira env vars for the extension
    const jiraEnv = {};
    const jiraTokens = this._loadJiraTokens();
    if (jiraTokens?.cloudId) {
      // Pre-refresh the access token server-side so the Pi extension doesn't need to
      const freshToken = await this._refreshJiraAccessToken(jiraTokens);
      jiraEnv.JIRA_AUTH_MODE = "oauth";
      jiraEnv.JIRA_CLOUD_ID = jiraTokens.cloudId;
      jiraEnv.JIRA_ACCESS_TOKEN = freshToken;
    } else if (this.config.jira.email && this.config.jira.token) {
      jiraEnv.JIRA_AUTH_MODE = "basic";
      jiraEnv.JIRA_BASE_URL = this.config.jira.baseUrl;
      jiraEnv.JIRA_EMAIL = this.config.jira.email;
      jiraEnv.JIRA_API_TOKEN = this.config.jira.token;
    }

    // Build GitHub env vars
    const githubEnv = {};
    // Get a fresh GitHub App installation token
    const { GitHubClient } = await import("../../extensions/github/client.mjs");
    const ghClient = new GitHubClient(this.config);
    if (ghClient.configured) {
      try {
        const ghToken = await ghClient.getInstallationToken();
        githubEnv.GITHUB_ACCESS_TOKEN = ghToken;
      } catch (e) { console.log("[pi] GitHub token error:", e.message); }
    }

    const created = await vm.createSession("pi", {
      cwd: VM_WORKSPACE,
      env: {
        HOME: VM_HOME,
        PI_SESSION_DIR: `${VM_WORKSPACE}/.pi-sessions`,
        FIGMA_ARTIFACTS_DIR: `${VM_WORKSPACE}/figma-artifacts`,
        ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
        ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
        ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
        ...(process.env.FIGMA_PERSONAL_ACCESS_TOKEN ? { FIGMA_PERSONAL_ACCESS_TOKEN: process.env.FIGMA_PERSONAL_ACCESS_TOKEN } : {}),
        ...(process.env.FIGMA_TEAM_ID ? { FIGMA_TEAM_ID: process.env.FIGMA_TEAM_ID } : {}),
        ...(process.env.FIGMA_OUTPUT_DIR ? { FIGMA_OUTPUT_DIR: process.env.FIGMA_OUTPUT_DIR } : {}),
        ...jiraEnv,
        ...githubEnv,
      },
      additionalInstructions: systemPrompt(this.mode),
    });
    const sessionId = created.sessionId;
    console.log("[pi:agentos] session:", sessionId, "model:", defaultProvider + "/" + defaultModel);
    await onEvent("agent.session_created", { sessionId, model: defaultProvider + "/" + defaultModel, thinkingLevel, runtime: "agentos", tools: ["read", "bash", "edit", "write", "grep", "jira_get_issue", "jira_get_comments", "jira_list_attachments", "jira_download_attachment", "jira_search", "jira_count", "jira_board_jql", "jira_board_count", "figma_get_file", "figma_find_nodes", "figma_get_node_subtree", "figma_inspect_node", "figma_export_assets", "view_image", "list_directory", "find_files", "figma_get_components", "figma_get_styles", "figma_get_comments", "figma_get_images", "figma_search", "contentful_http_get", "contentful_list_content_types", "contentful_get_content_type", "contentful_list_entries", "contentful_get_entry", "jira_add_comment", "jira_list_transitions", "jira_transition_issue", ...toolKits.map((k) => k.name)] });

    // Create live session first so the event handler can reference it
    const live = new LiveSession({ vm, sessionId, unsub: null, runtime: "agentos", model: defaultProvider + "/" + defaultModel, thinkingLevel });
    live.onEvent = onEvent;
    this.sessions.set(job.id, live);

    // Event handler uses live.onEvent so follow-ups get events routed correctly
    const unsub = vm.onSessionEvent(sessionId, (event) => {
      const cb = live.onEvent;
      if (!cb) return;
      const text = acpText(event);
      if (text) { void cb("agent.text", { text }); return; }
      const thinking = acpThinking(event);
      if (thinking) { void cb("agent.thinking", { text: thinking }); return; }
      const tool = acpToolCall(event);
      if (tool) { void cb("agent.tool_acp", tool); return; }
    });
    live.unsub = unsub;

    const result = await vm.prompt(sessionId, job.prompt);
    console.log("[pi:agentos] done, text:", result.text?.length || 0);
    if (result.response?.error) throw new Error(result.response.error.message || JSON.stringify(result.response.error));
    return { sessionId, text: result.text || "" };
  }

  // ── Direct Pi SDK runtime ────────────────────────────────────
  async _startDirect(job, onEvent) {
    const jobDir = job.workspacePath;
    const jobRepoDir = resolve(jobDir, "repo");
    await mkdir(jobDir, { recursive: true });

    if (this.config.workspace.exists && !existsSync(jobRepoDir)) {
      console.log("[pi:direct] cloning workspace...");
      await onEvent("job.cloning", { src: this.config.workspace.path });
      const result = await cloneWorkspace(this.config.workspace.path, jobRepoDir);
      console.log("[pi:direct] clone done:", result.method);
      await onEvent("job.cloned", result);
    }

    const cwd = existsSync(jobRepoDir) ? jobRepoDir : jobDir;
    const modelStr = job.model || this.config.runtime.model;
    const thinkingLevel = effectiveThinkingLevel(job, this.config);
    const agentDir = getAgentDir();
    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, appendSystemPrompt: systemPrompt("direct") });
    await resourceLoader.reload();

    let model;
    if (modelStr) {
      let provider, modelId;
      if (modelStr.includes("/")) [provider, modelId] = modelStr.split("/", 2);
      else modelId = modelStr;
      const all = modelRegistry.getAll();
      if (provider) model = all.find((m) => m.provider === provider && m.id === modelId);
      if (!model && provider) model = all.find((m) => m.provider === provider && m.id.includes(modelId));
      if (!model) model = all.find((m) => m.id === modelId);
    }

    const tools = [...codingTools, createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
    // Use file-backed session manager for persistence across restarts
    const sessDir = resolve(job.workspacePath, ".pi-sessions");
    await mkdir(sessDir, { recursive: true });
    let sessionManager;
    if (job.piSessionFile && existsSync(job.piSessionFile)) {
      sessionManager = SessionManager.open(job.piSessionFile, sessDir);
      console.log("[pi:direct] resuming session from:", job.piSessionFile);
    } else {
      sessionManager = SessionManager.create(cwd, sessDir);
    }
    const { session } = await createAgentSession({ cwd, sessionManager, resourceLoader, authStorage, modelRegistry, tools, thinkingLevel, ...(model ? { model } : {}) });
    if (!session.model) throw new Error(`No model available. Tried: ${modelStr}`);
    // Persist the session file path to the job record
    job.piSessionFile = sessionManager.getSessionFile();

    console.log("[pi:direct] session:", session.sessionId, "model:", session.model.provider + "/" + session.model.id, "cwd:", cwd);
    await onEvent("agent.session_created", { sessionId: session.sessionId, model: session.model.provider + "/" + session.model.id, thinkingLevel, runtime: "direct", tools: tools.map((t) => t.name), cwd });

    const live = new LiveSession({ piSession: session, sessionId: session.sessionId, unsub: null, runtime: "direct", model: session.model.provider + "/" + session.model.id, thinkingLevel });
    live.onEvent = onEvent;
    this.sessions.set(job.id, live);

    const unsub = session.subscribe((event) => {
      const cb = live.onEvent;
      if (!cb) return;
      if (event.type === "message_update") {
        const ame = event.assistantMessageEvent;
        if (!ame) return;
        if (ame.type === "text_delta" && "delta" in ame) void cb("agent.text", { text: String(ame.delta) });
        if (ame.type === "thinking_delta" && "delta" in ame) void cb("agent.thinking", { text: String(ame.delta) });
        if (ame.type === "toolcall_start" && ame.toolCall) void cb("agent.tool", { phase: "start", name: ame.toolCall.name, id: ame.toolCall.id });
        if (ame.type === "toolcall_end" && ame.toolCall) void cb("agent.tool", { phase: "end", name: ame.toolCall.name, id: ame.toolCall.id });
      }
      if (event.type === "tool_execution_start") void cb("agent.tool_exec", { phase: "start", tool: event.toolName, args: event.args });
      if (event.type === "tool_execution_end") void cb("agent.tool_exec", { phase: "end", tool: event.toolName, isError: event.isError, result: typeof event.result === "string" ? event.result.slice(0, 5000) : JSON.stringify(event.result).slice(0, 5000) });
    });
    live.unsub = unsub;

    await session.prompt(job.prompt);
    console.log("[pi:direct] done");
    return { sessionId: session.sessionId, text: "" };
  }

  disposeJob(jobId) { const s = this.sessions.get(jobId); if (s) { s.dispose(); this.sessions.delete(jobId); } }
  disposeAll() { for (const s of this.sessions.values()) s.dispose(); this.sessions.clear(); clearInterval(this._reaper); }
}
