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

// Direct Pi SDK imports for fallback runtime
import { createAgentSession, SessionManager, DefaultResourceLoader, AuthStorage, ModelRegistry, getAgentDir, codingTools, createGrepTool, createFindTool, createLsTool } from "@mariozechner/pi-coding-agent";

const VM_HOME = "/home/user";
const VM_WORKSPACE = "/home/user/workspace";

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
  constructor({ vm, piSession, sessionId, unsub, runtime }) {
    this.vm = vm;
    this.piSession = piSession;
    this.sessionId = sessionId;
    this.unsub = unsub;
    this.runtime = runtime;
    this.lastActivity = Date.now();
  }
  async prompt(text) {
    this.lastActivity = Date.now();
    if (this.vm) return this.vm.prompt(this.sessionId, text);
    if (this.piSession) { await this.piSession.prompt(text); return { text: "" }; }
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
    if (this.sessions.has(job.id)) return this._followUp(job, onEvent);
    if (this.mode === "direct") return this._startDirect(job, onEvent);
    return this._startAgentOs(job, onEvent);
  }

  async _followUp(job, onEvent) {
    const live = this.sessions.get(job.id);
    console.log("[pi] follow-up:", live.sessionId);
    await onEvent("agent.follow_up", { sessionId: live.sessionId });
    await live.prompt(job.prompt);
    console.log("[pi] follow-up done");
    return { sessionId: live.sessionId, text: "" };
  }

  // ── Agent OS runtime ─────────────────────────────────────────
  async _startAgentOs(job, onEvent) {
    const jobDir = job.workspacePath;
    const jobRepoDir = resolve(jobDir, "repo");
    await mkdir(jobDir, { recursive: true });

    if (this.config.workspace.exists && !existsSync(jobRepoDir)) {
      console.log("[pi:agentos] cloning workspace...");
      await onEvent("job.cloning", { src: this.config.workspace.path });
      const result = await cloneWorkspace(this.config.workspace.path, jobRepoDir);
      console.log("[pi:agentos] clone done:", result.method);
      await onEvent("job.cloned", result);
    }

    const model = job.model || this.config.runtime.model;
    let defaultProvider = "openai-codex", defaultModel = "gpt-5.4";
    if (model?.includes("/")) [defaultProvider, defaultModel] = model.split("/", 2);
    else if (model) defaultModel = model;

    const hasRepo = existsSync(jobRepoDir);
    const mounts = hasRepo ? [{ path: VM_WORKSPACE, driver: createHostDirBackend({ hostPath: jobRepoDir, readOnly: false }), readOnly: false }] : [];

    const toolKits = collectToolkits({ config: this.config, job, processes: this.processes }, this.extensions);
    const vm = await AgentOs.create({ software: [common, pi], mounts, toolKits, additionalInstructions: systemPrompt(this.mode) });

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

    await vm.writeFile(`${piDir}/settings.json`, JSON.stringify({ defaultProvider, defaultModel, defaultThinkingLevel: "low" }, null, 2));
    await vm.mkdir(VM_WORKSPACE, { recursive: true });

    // Write Pi extensions into VFS so they load as native tools
    const extDir = `${VM_HOME}/.pi/agent/extensions`;
    await vm.mkdir(extDir, { recursive: true });

    // Jira extension: reads OAuth config from env vars
    await vm.writeFile(`${extDir}/jira-tools.js`, piJiraExtensionSource());

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

    const created = await vm.createSession("pi", {
      cwd: VM_WORKSPACE,
      env: {
        HOME: VM_HOME,
        ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
        ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
        ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
        ...jiraEnv,
      },
      additionalInstructions: systemPrompt(this.mode),
    });
    const sessionId = created.sessionId;
    console.log("[pi:agentos] session:", sessionId, "model:", defaultProvider + "/" + defaultModel);
    await onEvent("agent.session_created", { sessionId, model: defaultProvider + "/" + defaultModel, runtime: "agentos", tools: ["read", "bash", "edit", "write", "grep", "jira_get_issue", "jira_get_comments", "jira_search", "jira_add_comment", "jira_list_transitions", "jira_transition_issue", ...toolKits.map((k) => k.name)] });

    const unsub = vm.onSessionEvent(sessionId, (event) => {
      const text = acpText(event);
      if (text) { void onEvent("agent.text", { text }); return; }
      const thinking = acpThinking(event);
      if (thinking) { void onEvent("agent.thinking", { text: thinking }); return; }
      const tool = acpToolCall(event);
      if (tool) { void onEvent("agent.tool_acp", tool); return; }
    });

    const live = new LiveSession({ vm, sessionId, unsub, runtime: "agentos" });
    this.sessions.set(job.id, live);

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
    const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(), resourceLoader, authStorage, modelRegistry, tools, ...(model ? { model } : {}) });
    if (!session.model) throw new Error(`No model available. Tried: ${modelStr}`);

    console.log("[pi:direct] session:", session.sessionId, "model:", session.model.provider + "/" + session.model.id, "cwd:", cwd);
    await onEvent("agent.session_created", { sessionId: session.sessionId, model: session.model.provider + "/" + session.model.id, runtime: "direct", tools: tools.map((t) => t.name), cwd });

    const unsub = session.subscribe((event) => {
      if (event.type === "message_update") {
        const ame = event.assistantMessageEvent;
        if (!ame) return;
        if (ame.type === "text_delta" && "delta" in ame) void onEvent("agent.text", { text: String(ame.delta) });
        if (ame.type === "thinking_delta" && "delta" in ame) void onEvent("agent.thinking", { text: String(ame.delta) });
        if (ame.type === "toolcall_start" && ame.toolCall) void onEvent("agent.tool", { phase: "start", name: ame.toolCall.name, id: ame.toolCall.id });
        if (ame.type === "toolcall_end" && ame.toolCall) void onEvent("agent.tool", { phase: "end", name: ame.toolCall.name, id: ame.toolCall.id });
      }
      if (event.type === "tool_execution_start") void onEvent("agent.tool_exec", { phase: "start", tool: event.toolName, args: event.args });
      if (event.type === "tool_execution_end") void onEvent("agent.tool_exec", { phase: "end", tool: event.toolName, isError: event.isError, result: typeof event.result === "string" ? event.result.slice(0, 5000) : JSON.stringify(event.result).slice(0, 5000) });
    });

    const live = new LiveSession({ piSession: session, sessionId: session.sessionId, unsub, runtime: "direct" });
    this.sessions.set(job.id, live);

    await session.prompt(job.prompt);
    console.log("[pi:direct] done");
    return { sessionId: session.sessionId, text: "" };
  }

  disposeJob(jobId) { const s = this.sessions.get(jobId); if (s) { s.dispose(); this.sessions.delete(jobId); } }
  disposeAll() { for (const s of this.sessions.values()) s.dispose(); this.sessions.clear(); clearInterval(this._reaper); }
}
