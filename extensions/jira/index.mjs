import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { JiraClient } from "./client.mjs";
import { trim } from "../../src/core/redact.mjs";

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
  const prompt = [
    `You are assigned to Jira issue ${key}.`,
    ``,
    `Recent events (${eventSummaries.length}):`,
    ...eventSummaries.map((s) => `- ${s}`),
    extra ? `\nAdditional instructions: ${trim(extra, 20_000)}` : "",
    issue ? `\n--- Jira Issue ---\n${JSON.stringify(issue, null, 2)}` : `\n(Could not fetch issue details. Use jira_get_issue tool to read it.)`,
    comments?.comments?.length ? `\n--- Recent Comments (last ${Math.min(comments.comments.length, 20)}) ---\n${JSON.stringify(comments.comments.slice(0, 20), null, 2)}` : "",
    ``,
    `Instructions:`,
    `1. Read the issue and comments carefully.`,
    `2. If the task is clear, proceed with implementation.`,
    `3. If unclear, use jira_add_comment to ask a clarifying question.`,
    `4. When done, use jira_add_comment to report your results.`,
  ].filter(Boolean).join("\n");
  return { issueKey: key, prompt };
}

const DEBOUNCE_MS = 30_000;

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
        const job = await store.create({ kind: "jira", title: key, issueKey: key, prompt, model: config.runtime.model, body: buf.firstBody, autoComment: false });
        runner.enqueue(job);
      }

      // --- OAuth routes ---

      app.get("/api/jira/oauth/authorize", (c) => {
        const oauth = config.jira.oauth;
        if (!oauth?.clientId) return c.json({ error: "JIRA_OAUTH_CLIENT_ID not configured" }, 400);
        const scopes = "read:jira-work write:jira-work read:jira-user manage:jira-project offline_access";
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
        const job = await store.create({ kind: "jira", title: key, issueKey: key, prompt, model: body.model || config.runtime.model, body, autoComment: body.autoComment });
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
        const status = body?.issue?.fields?.status?.name || "";
        const statusMatch = status && config.jira.triggerStatuses.includes(status);
        if (!mentioned && !statusMatch) return c.json({ ignored: true, reason: "no match" }, 202);

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

    toolkits({ config }) {
      const jira = new JiraClient(config);
      return [toolKit({
        name: "jira",
        description: "Jira issue tools",
        tools: {
          get_issue: hostTool({ description: "Fetch a Jira issue.", inputSchema: z.object({ issueKey: z.string().min(1) }), execute: ({ issueKey }) => jira.getIssue(issueKey) }),
          get_comments: hostTool({ description: "Fetch Jira comments.", inputSchema: z.object({ issueKey: z.string().min(1) }), execute: ({ issueKey }) => jira.getComments(issueKey) }),
          search: hostTool({ description: "JQL search.", inputSchema: z.object({ jql: z.string().min(1), max: z.number().default(10) }), execute: ({ jql, max }) => jira.search(jql, max) }),
          add_comment: hostTool({ description: "Comment on issue.", inputSchema: z.object({ issueKey: z.string().min(1), comment: z.string().min(1) }), execute: ({ issueKey, comment }) => jira.addComment(issueKey, comment) }),
          list_transitions: hostTool({ description: "List transitions.", inputSchema: z.object({ issueKey: z.string().min(1) }), execute: ({ issueKey }) => jira.listTransitions(issueKey) }),
          transition_issue: hostTool({ description: "Transition issue.", inputSchema: z.object({ issueKey: z.string().min(1), transitionId: z.string().min(1) }), execute: ({ issueKey, transitionId }) => jira.transitionIssue(issueKey, transitionId) }),
        },
      })];
    },
  };
}
