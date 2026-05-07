import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { resolve } from "node:path";
import { JiraClient } from "./client.mjs";
import { trim } from "../../src/core/redact.mjs";
import { formatIssue, formatComments } from "./format.mjs";

function issueKey(body) {
  return body?.issueKey || body?.issue_key || body?.key || body?.issue?.key || "";
}

function commentText(body) {
  const c = body?.comment;
  if (!c) return "";
  if (typeof c === "string") return c;
  if (typeof c.body === "string") return c.body;
  return "";
}

function normLabel(s) { return String(s || "").trim().toLowerCase(); }
function configuredLabelSet(config) { return new Set((config.jira.triggerLabels || []).map(normLabel).filter(Boolean)); }
function configuredStatusSet(config) { return new Set((config.jira.triggerStatuses || []).map(normLabel).filter(Boolean)); }

function statusTriggerInfo(config, body) {
  const wanted = configuredStatusSet(config);
  if (!wanted.size) return { matched: false, statuses: [] };

  // Only status-change webhooks should match status triggers. Do not trigger on
  // comments/other issue_updated events merely because the issue is currently
  // in a configured status; that creates self-trigger loops when agents comment.
  const changelog = body?.changelog?.items || [];
  const statusChanges = changelog.filter((c) => normLabel(c.field) === "status");
  const matched = [];
  for (const c of statusChanges) {
    const to = c.toString || body?.issue?.fields?.status?.name || "";
    if (wanted.has(normLabel(to))) matched.push(to);
  }
  return { matched: matched.length > 0, statuses: matched };
}

function labelTriggerInfo(config, body) {
  const wanted = configuredLabelSet(config);
  if (!wanted.size) return { matched: false, labels: [] };
  const current = (body?.issue?.fields?.labels || []).map(String);
  const currentMatches = current.filter((l) => wanted.has(normLabel(l)));
  const changelog = body?.changelog?.items || [];
  const labelChanges = changelog.filter((c) => normLabel(c.field) === "labels");
  if (!labelChanges.length) return { matched: false, labels: currentMatches };
  const added = [];
  for (const c of labelChanges) {
    const before = new Set(String(c.fromString || "").split(/[, ]+/).map(normLabel).filter(Boolean));
    const after = new Set(String(c.toString || "").split(/[, ]+/).map(normLabel).filter(Boolean));
    for (const l of after) if (!before.has(l) && wanted.has(l)) added.push(l);
  }
  return { matched: added.length > 0 || currentMatches.length > 0, labels: added.length ? added : currentMatches };
}

async function buildPrompt(config, body, batchedEvents) {
  const key = issueKey(body);
  if (!key) throw new Error("Missing issue key");
  const jira = new JiraClient(config);
  let issue = null, comments = null;
  if (jira.configured) {
    try { issue = await jira.getIssue(key); } catch (e) { console.log("[jira] failed to fetch issue:", e.message); }
    try { comments = await jira.getComments(key); } catch (e) { console.log("[jira] failed to fetch comments:", e.message); }
  }

  const events = batchedEvents || [body];
  const eventSummaries = events.map((evt) => {
    if (evt._triggerReason) return evt._triggerReason;
    const comment = commentText(evt);
    const webhookEvent = evt.webhookEvent || "trigger";
    const user = evt.user?.displayName || evt.comment?.author?.displayName || "unknown";
    if (comment) return `[${user}] commented: ${trim(comment, 2000)}`;
    // Include changelog for field updates
    const changelog = evt.changelog?.items;
    if (changelog?.length) {
      const changes = changelog.map((c) => `${c.field}: "${c.fromString || ""}" → "${c.toString || ""}"`).join(", ");
      return `[${user}] ${webhookEvent}: ${changes}`;
    }
    return `[${webhookEvent}] ${evt.issue?.fields?.status?.name || ""}`;
  });

  const extra = body.prompt || body.instructions || "";
  const noExplicitInstructions = !extra.trim();
  const prompt = [
    `You are assigned to Jira issue ${key}.`,
    ``,
    `## What just happened (RESPOND TO THIS):`,
    ...eventSummaries.map((s) => `- ${s}`),
    ``,
    `The above is what triggered this turn. Address it directly.`,
    extra ? `\nAdditional instructions: ${trim(extra, 20_000)}` : "",
    ``,
    `## Background context`,
    issue ? `\n### Issue\n${formatIssue(issue)}` : `\n(Could not fetch issue. Use jira_get_issue if needed.)`,
    comments?.comments?.length ? `\n### Comment history\n${formatComments({ comments: comments.comments.slice(0, 20) })}` : "",
    ``,
    `## Rules`,
    `- Focus on what just happened above. Do not re-summarize the whole ticket.`,
    `- If someone asked a question or gave feedback, respond to THAT specifically.`,
    `- This was triggered from Jira. You must keep the Jira ticket updated with progress using the native jira_add_comment tool. Do not use node /usr/local/bin/agentos-jira or any AgentOS Jira CLI shim.`,
    `- After initial investigation, always add a Jira progress comment with your plan, concrete questions, or current blocker before stopping or doing substantial implementation.`,
    `- If you become blocked/unclear, add a Jira comment explaining the blocker and exactly what you need, then stop.`,
    `- Before finishing, add a Jira comment summarizing what changed, tests run, and status. Do not finish a Jira-triggered turn without at least one Jira comment.`,
    noExplicitInstructions ? `- This was started without explicit extra instructions. First investigate the ticket and relevant code. If anything is unclear, add a Jira comment with your plan and concrete questions, then stop and wait for clarification. If it is clear, proceed with implementation and still report your plan/results in Jira.` : "",
    `- If the issue has relevant attachments, use jira_list_attachments and jira_download_attachment to inspect them before implementing.`,
    `- If the task is clear, implement it.`,
    `- If unclear, use jira_add_comment to ask a clarifying question and include your proposed plan.`,
    `- When done, use jira_add_comment to report results.`,
  ].filter(Boolean).join("\n");
  return { issueKey: key, prompt };
}

const DEBOUNCE_MS = 5_000;

export function jiraExtension() {
  // Webhook debounce buffer: issueKey -> { events: [], timer, firstBody }
  const webhookBuffer = new Map();

  return {
    id: "jira",
    description: "Jira triggers and tools",

    routes(app, { config, store, runner }) {

      // --- Flush debounced webhook events ---
      async function flushWebhook(key) {
        const buf = webhookBuffer.get(key);
        if (!buf) return;
        webhookBuffer.delete(key);
        console.log(`[jira] flushing ${buf.events.length} webhook events for ${key}`);

        const { prompt } = await buildPrompt(config, buf.firstBody, buf.events);

        // Find existing session for this issue key, or create new
        const existing = store.findByIssueKey(key);
        if (existing && existing.status !== "cancelled" && existing.status !== "queued") {
          // If running, just log the follow-up event — the debounce will catch the next window
          if (existing.status === "running") {
            await store.event(existing.id, "follow_up.pending", { prompt: prompt.slice(0, 50_000), source: "jira_webhook", note: "job is running, will retry" });
            // Re-buffer for retry after current run completes
            const retryBuf = { events: buf.events, firstBody: buf.firstBody, timer: null };
            retryBuf.timer = setTimeout(() => flushWebhook(key), 15_000);
            webhookBuffer.set(key, retryBuf);
            return;
          }
          await store.update(existing.id, { status: "queued", prompt });
          await store.event(existing.id, "follow_up.queued", { prompt: prompt.slice(0, 50_000), source: "jira_webhook", batchSize: buf.events.length });
          runner.enqueue(store.get(existing.id));
          return;
        }
        const job = await store.create({ kind: "jira", title: key, issueKey: key, prompt, model: config.runtime.model, thinkingLevel: config.runtime.thinkingLevel, body: buf.firstBody, autoComment: false });
        runner.enqueue(job);
      }

      // --- OAuth routes ---

      app.get("/api/jira/oauth/authorize", (c) => {
        const oauth = config.jira.oauth;
        if (!oauth?.clientId) return c.json({ error: "JIRA_OAUTH_CLIENT_ID not configured" }, 400);
        const scopes = "read:jira-work write:jira-work read:jira-user manage:jira-project read:attachment:jira read:board-scope:jira-software read:project:jira read:filter:jira read:jql:jira offline_access";
        const callbackUrl = `${c.req.header("x-forwarded-proto") || "http"}://${c.req.header("host")}/api/jira/oauth/callback`;
        const state = Math.random().toString(36).slice(2);
        const url = `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${oauth.clientId}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}&response_type=code&prompt=consent`;
        return c.redirect(url);
      });

      app.get("/api/jira/oauth/callback", async (c) => {
        const code = c.req.query("code");
        if (!code) return c.json({ error: "No authorization code received" }, 400);
        const jira = new JiraClient(config);
        const callbackUrl = `${c.req.header("x-forwarded-proto") || "http"}://${c.req.header("host")}/api/jira/oauth/callback`;
        try {
          const tokens = await jira.exchangeCode(code, callbackUrl);
          return c.html(`<h1>Jira OAuth connected</h1><p>Site: ${tokens.siteName || "connected"}</p><p>Cloud ID: ${tokens.cloudId}</p><p><a href="/ui">Back to dashboard</a></p>`);
        } catch (e) {
          return c.json({ error: e.message }, 500);
        }
      });

      app.get("/api/jira/oauth/status", async (c) => {
        const jira = new JiraClient(config);
        if (jira.mode === "none") return c.json({ connected: false, mode: "none" });
        if (jira.mode === "basic") return c.json({ connected: true, mode: "basic", email: config.jira.email });
        const tokens = jira._loadTokens();
        return c.json({ connected: !!tokens?.refresh_token, mode: "oauth", site: tokens?.siteName || null, cloudId: tokens?.cloudId || null });
      });

      // --- Node-side JQL utility route ---

      async function runJqlRoute(c) {
        const body = c.req.method === "GET" ? {} : await c.req.json().catch(() => ({}));
        const jql = body.jql || c.req.query("jql");
        const board = body.board || body.boardId || c.req.query("board") || c.req.query("boardId");
        if ((!jql || typeof jql !== "string") && !board) return c.json({ error: "jql or board required" }, 400);
        const countOnly = Boolean(body.count || body.countOnly || c.req.query("count") === "1" || c.req.query("countOnly") === "1");
        const jira = new JiraClient(config);
        if (countOnly) return c.json(board ? await jira.countBoard(board, jql || "") : await jira.countJql(jql));
        const max = Number(body.maxResults || body.max || c.req.query("maxResults") || c.req.query("max") || 10);
        return c.json(board ? await jira.searchBoard(board, jql || "", Number.isFinite(max) ? max : 10) : await jira.search(jql, Number.isFinite(max) ? max : 10));
      }

      app.get("/api/jira/search", runJqlRoute);
      app.post("/api/jira/search", runJqlRoute);

      // --- Trigger routes ---

      app.post("/api/jira/trigger", async (c) => {
        const body = await c.req.json();
        const { issueKey: key, prompt } = await buildPrompt(config, body);
        const existing = store.findByIssueKey(key);
        if (existing && (existing.status !== "cancelled" && existing.status !== "queued")) {
          if (existing.status === "running") {
            return c.json({ job: store.pub(existing), running: true, message: "Job is running, follow-up will be delivered after current turn" }, 202);
          }
          await store.update(existing.id, { status: "queued", prompt });
          await store.event(existing.id, "follow_up.queued", { prompt: prompt.slice(0, 50_000), source: "jira_trigger" });
          runner.enqueue(store.get(existing.id));
          return c.json({ job: store.pub(store.get(existing.id)), continued: true }, 202);
        }
        const job = await store.create({ kind: "jira", title: key, issueKey: key, prompt, model: body.model || config.runtime.model, thinkingLevel: body.thinkingLevel || body.thinking || config.runtime.thinkingLevel, body, autoComment: body.autoComment });
        runner.enqueue(job);
        return c.json({ job: store.pub(job) }, 202);
      });

      // --- Webhook with debouncing ---

      app.post("/api/jira/webhook", async (c) => {
        const body = await c.req.json();
        const key = issueKey(body);
        if (!key) return c.json({ ignored: true, reason: "no issue key" }, 202);

        const text = commentText(body);
        const mentioned = text.includes(config.jira.triggerMention);
        const statusInfo = statusTriggerInfo(config, body);
        const statusMatch = statusInfo.matched;
        const labelInfo = labelTriggerInfo(config, body);
        const labelMatch = labelInfo.matched;
        if (!mentioned && !statusMatch && !labelMatch) return c.json({ ignored: true, reason: "no match" }, 202);
        if (statusMatch) body._triggerReason = `Triggered because Jira status transitioned to: ${statusInfo.statuses.join(", ")}.`;
        if (labelMatch) body._triggerReason = `Triggered because Jira label matched: ${labelInfo.labels.join(", ")}.`;

        // Buffer this event, debounce 30s
        const existing = webhookBuffer.get(key);
        if (existing) {
          existing.events.push(body);
          clearTimeout(existing.timer);
          existing.timer = setTimeout(() => flushWebhook(key), DEBOUNCE_MS);
          console.log(`[jira] buffered event for ${key} (${existing.events.length} total, debouncing ${DEBOUNCE_MS}ms)`);
          return c.json({ buffered: true, issueKey: key, pending: existing.events.length }, 202);
        }

        const buf = { events: [body], firstBody: body, timer: null };
        buf.timer = setTimeout(() => flushWebhook(key), DEBOUNCE_MS);
        webhookBuffer.set(key, buf);
        console.log(`[jira] buffering webhook for ${key} (debouncing ${DEBOUNCE_MS}ms)`);
        return c.json({ buffered: true, issueKey: key, pending: 1 }, 202);
      });
    },

    toolkits({ config, job }) {
      const jira = new JiraClient(config);
      const jiraArtifactsDir = job?.jiraArtifactsDir || (job?.workspacePath ? resolve(job.workspacePath, "jira-artifacts") : resolve(config.paths.data, "jira-attachments"));
      return [toolKit({
        name: "jira",
        description: "Jira issue tools",
        tools: {
          get_issue: hostTool({ description: "Fetch a Jira issue.", inputSchema: z.object({ issueKey: z.string().min(1) }), execute: ({ issueKey }) => jira.getIssue(issueKey) }),
          get_comments: hostTool({ description: "Fetch Jira comments.", inputSchema: z.object({ issueKey: z.string().min(1) }), execute: ({ issueKey }) => jira.getComments(issueKey) }),
          list_attachments: hostTool({ description: "List attachments on a Jira issue.", inputSchema: z.object({ issueKey: z.string().min(1) }), execute: ({ issueKey }) => jira.listAttachments(issueKey) }),
          download_attachment: hostTool({ description: "Download a Jira attachment by id into job artifacts.", inputSchema: z.object({ attachmentId: z.string().min(1) }), execute: async ({ attachmentId }) => {
            const out = await jira.downloadAttachment(attachmentId, jiraArtifactsDir);
            if (job?.jiraArtifactsDir && out.path?.startsWith(job.jiraArtifactsDir)) out.vmPath = `/home/user/workspace/jira-artifacts${out.path.slice(job.jiraArtifactsDir.length)}`;
            return out;
          } }),
          search: hostTool({ description: "JQL search.", inputSchema: z.object({ jql: z.string().min(1), max: z.number().default(10) }), execute: ({ jql, max }) => jira.search(jql, max) }),
          count: hostTool({ description: "Count issues matching a JQL query without fetching issue details.", inputSchema: z.object({ jql: z.string().min(1) }), execute: ({ jql }) => jira.countJql(jql) }),
          board_jql: hostTool({ description: "Resolve a Jira board id or /board/3 path to the board filter JQL.", inputSchema: z.object({ board: z.string().min(1) }), execute: ({ board }) => jira.getBoardJql(board) }),
          board_search: hostTool({ description: "Search issues constrained by a Jira board filter, optionally ANDed with extra JQL.", inputSchema: z.object({ board: z.string().min(1), jql: z.string().default(""), max: z.number().default(10) }), execute: ({ board, jql, max }) => jira.searchBoard(board, jql, max) }),
          board_count: hostTool({ description: "Count issues constrained by a Jira board filter, optionally ANDed with extra JQL.", inputSchema: z.object({ board: z.string().min(1), jql: z.string().default("") }), execute: ({ board, jql }) => jira.countBoard(board, jql) }),
          add_comment: hostTool({ description: "Comment on issue.", inputSchema: z.object({ issueKey: z.string().min(1), comment: z.string().min(1) }), execute: ({ issueKey, comment }) => jira.addComment(issueKey, comment) }),
          list_transitions: hostTool({ description: "List transitions.", inputSchema: z.object({ issueKey: z.string().min(1) }), execute: ({ issueKey }) => jira.listTransitions(issueKey) }),
          transition_issue: hostTool({ description: "Transition issue.", inputSchema: z.object({ issueKey: z.string().min(1), transitionId: z.string().min(1) }), execute: ({ issueKey, transitionId }) => jira.transitionIssue(issueKey, transitionId) }),
        },
      })];
    },
  };
}
