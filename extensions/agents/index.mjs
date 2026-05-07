import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { trim } from "../../src/core/redact.mjs";

function appUrl(config, jobId) {
  const base = config.server.publicUrl || process.env.PUBLIC_URL || "";
  const path = `/app#chat/${jobId}`;
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

function childPrompt({ parentJobId, issueKey, instructions }) {
  return [
    `You are an independent child background agent${parentJobId ? ` started by parent job ${parentJobId}` : ""}.`,
    `The parent agent can only start you. It cannot retrieve your output or observe what happened.`,
    `Do not wait for the parent. Complete the task independently and report through the normal external channel when appropriate.`,
    issueKey ? `\nYou are assigned to Jira issue ${issueKey}.` : "",
    `\n## Instructions\n${trim(instructions, 50_000)}`,
    `\n## Rules`,
    `- Start by inspecting the relevant ticket/code/context yourself; do not assume the parent verified everything.`,
    `- If you were given a Jira issue key, use native Jira tools to fetch the issue/comments and use jira_add_comment for progress and final status.`,
    `- If you make code changes, commit and push them, then open/update a PR when appropriate.`,
    `- Before finishing, summarize files changed, tests run, and status.`,
  ].filter(Boolean).join("\n");
}

export function agentsExtension() {
  const spawnedByParent = new Map();

  return {
    id: "agents",
    description: "Start background agents from agents",

    toolkits({ config, job, store, runner }) {
      return [toolKit({
        name: "agents",
        description: "Start child background agents",
        tools: {
          start_agent: hostTool({
            description: "Start a new background agent. Fire-and-forget; cannot retrieve child results.",
            inputSchema: z.object({
              instructions: z.string().min(1),
              title: z.string().optional(),
              issueKey: z.string().optional(),
              model: z.string().optional(),
              thinkingLevel: z.string().optional(),
              autoComment: z.boolean().default(false),
              allowDuplicateIssue: z.boolean().default(false),
            }),
            execute: async ({ instructions, title, issueKey, model, thinkingLevel, autoComment, allowDuplicateIssue }) => {
              if (!store || !runner) throw new Error("Agent starter is not wired to the job runner");

              const parentId = job?.id || null;
              const parent = parentId ? store.get(parentId) : null;
              const limit = config.runtime.agentSpawnLimit || 25;
              let reservedSpawnSlot = false;
              const reserveSpawnSlot = () => {
                if (!parentId || reservedSpawnSlot) return;
                const current = spawnedByParent.get(parentId) ?? parent?.spawnedAgentCount ?? 0;
                if (current >= limit) throw new Error(`start_agent limit reached for this parent job (${limit})`);
                spawnedByParent.set(parentId, current + 1);
                reservedSpawnSlot = true;
              };

              try {
                const normalizedIssueKey = issueKey ? String(issueKey).trim().toUpperCase() : "";
                if (normalizedIssueKey && !allowDuplicateIssue) {
                  const existing = store.findByIssueKey(normalizedIssueKey);
                  if (existing && existing.id !== parentId && (existing.status === "queued" || existing.status === "running")) {
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

                reserveSpawnSlot();
                const child = await store.create({
                  kind: "child_agent",
                  title: title || normalizedIssueKey || `Child of ${parentId ? parentId.slice(4, 16) : "agent"}`,
                  issueKey: normalizedIssueKey || null,
                  prompt: childPrompt({ parentJobId: parentId, issueKey: normalizedIssueKey, instructions }),
                  model: model || job?.model || config.runtime.model,
                  thinkingLevel: thinkingLevel || job?.thinkingLevel || config.runtime.thinkingLevel,
                  body: { source: "start_agent", parentJobId: parentId, instructions: trim(instructions, 5_000) },
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
                if (parentId && reservedSpawnSlot) {
                  const current = spawnedByParent.get(parentId) || 1;
                  spawnedByParent.set(parentId, Math.max(0, current - 1));
                }
                throw e;
              }
            },
          }),
        },
      })];
    },
  };
}
