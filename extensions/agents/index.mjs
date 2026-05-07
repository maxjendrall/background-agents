import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { trim } from "../../src/core/redact.mjs";

function appUrl(config, jobId) {
  const base = config.server.publicUrl || process.env.PUBLIC_URL || "";
  const path = `/app#chat/${jobId}`;
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

function normalizeIssueKey(value) {
  return String(value || "").trim().toUpperCase();
}

function genericPrompt({ parentJobId, instructions }) {
  return [
    `You are an independent child background agent${parentJobId ? ` started by parent job ${parentJobId}` : ""}.`,
    `The parent agent can only start you. It cannot retrieve your output or observe what happened.`,
    `Do not wait for the parent. Complete the task independently.`,
    `\n## Instructions\n${trim(instructions, 50_000)}`,
    `\n## Rules`,
    `- Inspect the relevant code/context yourself; do not assume the parent verified everything.`,
    `- If you make code changes, commit and push them, then open/update a PR when appropriate.`,
    `- Before finishing, summarize files changed, tests run, and status.`,
  ].join("\n");
}

function jiraPrompt({ parentJobId, issueKey, instructions }) {
  const extra = String(instructions || "").trim();
  return [
    `You are an independent child background agent${parentJobId ? ` started by parent job ${parentJobId}` : ""}.`,
    `The parent agent can only start you. It cannot retrieve your output or observe what happened.`,
    `Do not wait for the parent. Complete the task independently and report on Jira.`,
    `\nYou are assigned to Jira issue ${issueKey}. Start working on this ticket.`,
    extra ? `\nAdditional instructions from the parent:\n${trim(extra, 20_000)}` : "",
    `\n## Required workflow`,
    `1. Use jira_get_issue and jira_get_comments to inspect ${issueKey}.`,
    `2. If attachments, Figma links, Contentful data, or repository context are relevant, inspect them yourself.`,
    `3. If the task is clear, implement it with the smallest safe change.`,
    `4. If you change code, use native git_commit, git_push, and gh_pr_create/gh_pr_comment as appropriate.`,
    `5. At the end of the turn, add exactly one jira_add_comment summarizing changes, tests run, PR/status, and any blockers or clarification needed.`,
    `\n## Rules`,
    `- Do not rely on the parent agent for context or results.`,
    `- Do not add progress/acknowledgement comments while still working; comment only once at the end of the turn.`,
    `- If the latest event is your own previous AI comment with no new external feedback, do not comment again; summarize briefly and stop.`,
    `- Use native tools, especially Jira/Git/GitHub/Figma/Contentful tools, instead of CLI shims.`,
  ].filter(Boolean).join("\n");
}

export function agentsExtension() {
  const spawnedByParent = new Map();

  return {
    id: "agents",
    description: "Start background agents from agents",

    toolkits({ config, job, store, runner }) {
      const reserveSpawnSlot = () => {
        const parentId = job?.id || null;
        if (!parentId) return { parentId, reserved: false };
        const parent = store?.get(parentId);
        const limit = config.runtime.agentSpawnLimit || 25;
        const current = spawnedByParent.get(parentId) ?? parent?.spawnedAgentCount ?? 0;
        if (current >= limit) throw new Error(`start_agent limit reached for this parent job (${limit})`);
        spawnedByParent.set(parentId, current + 1);
        return { parentId, parent, reserved: true };
      };

      const releaseSpawnSlot = (parentId, reserved) => {
        if (!parentId || !reserved) return;
        const current = spawnedByParent.get(parentId) || 1;
        spawnedByParent.set(parentId, Math.max(0, current - 1));
      };

      const createChild = async ({ kind, source, title, issueKey, prompt, model, thinkingLevel, autoComment, body }) => {
        if (!store || !runner) throw new Error("Agent starter is not wired to the job runner");
        const { parentId, parent, reserved } = reserveSpawnSlot();
        try {
          const child = await store.create({
            kind,
            title,
            issueKey: issueKey || null,
            prompt,
            model: model || job?.model || config.runtime.model,
            thinkingLevel: thinkingLevel || job?.thinkingLevel || config.runtime.thinkingLevel,
            body: { source, parentJobId: parentId, ...(body || {}) },
            autoComment: Boolean(autoComment),
          });

          await store.update(child.id, { parentJobId: parentId });
          if (parentId) {
            const nextCount = spawnedByParent.get(parentId) ?? ((parent?.spawnedAgentCount || 0) + 1);
            await store.update(parentId, { spawnedAgentCount: nextCount });
            await store.event(parentId, "agent.spawned", {
              childJobId: child.id,
              title: child.title,
              issueKey: child.issueKey,
              source,
            });
          }
          runner.enqueue(child);

          return {
            jobId: child.id,
            status: "queued",
            title: child.title,
            issueKey: child.issueKey,
            url: appUrl(config, child.id),
            note: "Started only. This tool cannot retrieve child results; check the job URL/Jira/PRs externally.",
          };
        } catch (e) {
          releaseSpawnSlot(parentId, reserved);
          throw e;
        }
      };

      return [toolKit({
        name: "agents",
        description: "Start child background agents",
        tools: {
          start_jira_agent: hostTool({
            description: "Start a child agent for a Jira issue. Fire-and-forget; cannot retrieve results.",
            inputSchema: z.object({
              issueKey: z.string().min(1),
              instructions: z.string().optional(),
              title: z.string().optional(),
              model: z.string().optional(),
              thinkingLevel: z.string().optional(),
              allowDuplicateIssue: z.boolean().default(false),
            }),
            execute: async ({ issueKey, instructions, title, model, thinkingLevel, allowDuplicateIssue }) => {
              if (!store || !runner) throw new Error("Agent starter is not wired to the job runner");
              const normalizedIssueKey = normalizeIssueKey(issueKey);
              if (!normalizedIssueKey) throw new Error("issueKey is required");
              if (!allowDuplicateIssue) {
                const existing = store.findByIssueKey(normalizedIssueKey);
                if (existing && existing.id !== job?.id && (existing.status === "queued" || existing.status === "running")) {
                  return {
                    jobId: existing.id,
                    status: existing.status,
                    title: existing.title,
                    issueKey: normalizedIssueKey,
                    deduped: true,
                    url: appUrl(config, existing.id),
                    note: "Existing queued/running job returned. This tool cannot retrieve child results.",
                  };
                }
              }
              return createChild({
                kind: "jira_child_agent",
                source: "start_jira_agent",
                title: title || normalizedIssueKey,
                issueKey: normalizedIssueKey,
                prompt: jiraPrompt({ parentJobId: job?.id || null, issueKey: normalizedIssueKey, instructions }),
                model,
                thinkingLevel,
                autoComment: false,
                body: { instructions: trim(instructions || "", 5_000) },
              });
            },
          }),

          start_agent: hostTool({
            description: "Start a generic child agent. Fire-and-forget; cannot retrieve child results.",
            inputSchema: z.object({
              instructions: z.string().min(1),
              title: z.string().optional(),
              model: z.string().optional(),
              thinkingLevel: z.string().optional(),
            }),
            execute: ({ instructions, title, model, thinkingLevel }) => {
              const parentId = job?.id || null;
              return createChild({
                kind: "child_agent",
                source: "start_agent",
                title: title || `Child of ${parentId ? parentId.slice(4, 16) : "agent"}`,
                issueKey: null,
                prompt: genericPrompt({ parentJobId: parentId, instructions }),
                model,
                thinkingLevel,
                autoComment: false,
                body: { instructions: trim(instructions, 5_000) },
              });
            },
          }),
        },
      })];
    },
  };
}
