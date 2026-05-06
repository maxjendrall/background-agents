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

async function buildPrompt(config, body) {
  const key = issueKey(body);
  if (!key) throw new Error("Missing issue key");
  const jira = new JiraClient(config);
  let issue = null, comments = null;
  if (jira.configured) { issue = await jira.getIssue(key); comments = await jira.getComments(key); }
  const event = commentText(body) || body.webhookEvent || "trigger";
  const extra = body.prompt || body.instructions || "";
  return { issueKey: key, prompt: `Jira ${key}\n\nEvent: ${trim(event, 10_000)}\n${extra ? `\nInstructions: ${trim(extra, 20_000)}\n` : ""}${issue ? `\nIssue:\n${JSON.stringify(issue, null, 2)}\n` : ""}${comments ? `\nComments:\n${JSON.stringify(comments, null, 2)}\n` : ""}\nProceed according to your operating rules.` };
}

export function jiraExtension() {
  return {
    id: "jira",
    description: "Jira triggers and tools",

    routes(app, { config, store, runner }) {
      app.post("/api/jira/trigger", async (c) => {
        const body = await c.req.json();
        const { issueKey: key, prompt } = await buildPrompt(config, body);
        const job = await store.create({ kind: "jira", title: key, issueKey: key, prompt, model: body.model, body, autoComment: body.autoComment });
        runner.enqueue(job);
        return c.json({ job: store.pub(job) }, 202);
      });

      app.post("/api/jira/webhook", async (c) => {
        const body = await c.req.json();
        const key = issueKey(body);
        if (!key) return c.json({ ignored: true, reason: "no issue key" }, 202);
        const text = commentText(body);
        const mentioned = text.includes(config.jira.triggerMention);
        const status = body?.issue?.fields?.status?.name || "";
        const statusMatch = status && config.jira.triggerStatuses.includes(status);
        if (!mentioned && !statusMatch) return c.json({ ignored: true, reason: "no match" }, 202);
        const { prompt } = await buildPrompt(config, body);
        const job = await store.create({ kind: "jira", title: key, issueKey: key, prompt, body, autoComment: body.autoComment });
        runner.enqueue(job);
        return c.json({ job: store.pub(job) }, 202);
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
