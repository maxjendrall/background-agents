import type { AgentEvent, ChatMessage, ChatPart, ToolCall, ToolStatus } from "./types";

/**
 * Convert raw agent events into a chat-style message list.
 *
 * User turn = job.created (initial prompt) or follow_up.queued
 * Assistant turn = everything between user turns:
 *   - agent.text      → text part (streamed/accumulated)
 *   - agent.thinking  → thinking part (accumulated)
 *   - agent.tool_*    → tool part (start/update/end pairs)
 *   - job.cloning, job.cloned, agent.session_created, session.reset → system parts
 */
export function eventsToMessages(events: AgentEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let assistant: ChatMessage | null = null;
  let textPart: ChatPart | null = null;
  let thinkingPart: ChatPart | null = null;
  const toolsById = new Map<string, ChatPart>();

  function flushAssistant(status: "streaming" | "done" = "done") {
    if (assistant) {
      assistant.status = status;
      // Drop assistant if it has no parts
      if (assistant.parts.length === 0) {
        // do not push
      } else {
        messages.push(assistant);
      }
    }
    assistant = null;
    textPart = null;
    thinkingPart = null;
    toolsById.clear();
  }

  function ensureAssistant(ts: string) {
    if (!assistant) {
      assistant = {
        id: `asst-${messages.length}`,
        role: "assistant",
        parts: [],
        ts,
        status: "streaming",
      };
    }
  }

  function pushUser(prompt: string, ts: string, id: string) {
    flushAssistant("done");
    if (!prompt) return;
    messages.push({
      id,
      role: "user",
      parts: [{ kind: "text", text: prompt }],
      ts,
    });
  }

  function pushSystem(label: string, detail: string | undefined, tone: "info" | "warn" | "error", ts: string) {
    ensureAssistant(ts);
    assistant!.parts.push({ kind: "system", system: { label, detail, tone } });
  }

  for (const e of events) {
    const d = e.data || {};
    switch (e.type) {
      case "job.created": {
        const prompt = (d as any).prompt;
        if (prompt) pushUser(prompt, e.ts, e.id);
        break;
      }
      case "follow_up.queued": {
        const prompt = (d as any).prompt;
        if (prompt) pushUser(prompt, e.ts, e.id);
        break;
      }
      case "agent.session_created": {
        ensureAssistant(e.ts);
        const model = (d as any).model;
        const runtime = (d as any).runtime;
        pushSystem(
          "Session ready",
          [model, runtime].filter(Boolean).join(" · "),
          "info",
          e.ts,
        );
        break;
      }
      case "session.reset": {
        flushAssistant("done");
        messages.push({
          id: e.id,
          role: "system",
          parts: [{ kind: "system", system: { label: "Session reset", tone: "warn" } }],
          ts: e.ts,
        });
        break;
      }
      case "job.cloning":
      case "job.cloning_repos": {
        ensureAssistant(e.ts);
        pushSystem("Cloning workspace", (d as any).src || (d as any).repos?.join(", "), "info", e.ts);
        break;
      }
      case "job.cloned":
      case "job.repos_ready": {
        ensureAssistant(e.ts);
        pushSystem("Workspace ready", (d as any).method || undefined, "info", e.ts);
        break;
      }
      case "job.clone_failed": {
        ensureAssistant(e.ts);
        pushSystem("Clone failed", (d as any).error, "error", e.ts);
        break;
      }
      case "agent.text": {
        ensureAssistant(e.ts);
        if (!textPart) {
          textPart = { kind: "text", text: "" };
          assistant!.parts.push(textPart);
        }
        textPart.text = (textPart.text || "") + ((d as any).text || "");
        break;
      }
      case "agent.thinking": {
        ensureAssistant(e.ts);
        if (!thinkingPart) {
          thinkingPart = { kind: "thinking", thinking: "" };
          assistant!.parts.push(thinkingPart);
        }
        thinkingPart.thinking = (thinkingPart.thinking || "") + ((d as any).text || "");
        break;
      }
      case "agent.tool_acp": {
        ensureAssistant(e.ts);
        const td: any = d;
        if (td.type === "tool_start") {
          const tool: ToolCall = {
            id: td.id,
            name: td.name || "tool",
            status: (td.status as ToolStatus) || "pending",
            input: td.input,
            ts: e.ts,
          };
          const part: ChatPart = { kind: "tool", tool };
          toolsById.set(tool.id, part);
          assistant!.parts.push(part);
          // when a new tool starts, terminate any active text part for this turn so further text starts a new bubble
          textPart = null;
        } else if (td.type === "tool_update") {
          const part = toolsById.get(td.id);
          if (part?.tool) {
            if (td.status && td.status !== "pending") part.tool.status = td.status as ToolStatus;
            if (td.output?.content) {
              const texts = td.output.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text);
              if (texts.length) part.tool.outputText = texts.join("");
            }
            if (Array.isArray(td.content)) {
              const texts = td.content
                .filter((c: any) => c.type === "content" && c.content?.text)
                .map((c: any) => c.content.text);
              if (texts.length) part.tool.outputText = texts.join("");
            }
            if (td.rawInput && Object.keys(td.rawInput).length) {
              part.tool.input = td.rawInput;
            }
          }
        }
        break;
      }
      case "agent.tool": {
        ensureAssistant(e.ts);
        const td: any = d;
        if (td.phase === "start") {
          const id = td.id || `t-${Math.random().toString(36).slice(2, 8)}`;
          const tool: ToolCall = {
            id,
            name: td.name || "tool",
            status: "running",
            ts: e.ts,
          };
          const part: ChatPart = { kind: "tool", tool };
          toolsById.set(id, part);
          assistant!.parts.push(part);
          textPart = null;
        } else if (td.phase === "end") {
          // close most recent tool with this name
          const parts = [...toolsById.values()].reverse();
          const part = parts.find((p) => p.tool && p.tool.name === td.name && p.tool.status !== "completed");
          if (part?.tool) part.tool.status = "completed";
        }
        break;
      }
      case "agent.tool_exec": {
        ensureAssistant(e.ts);
        const td: any = d;
        if (td.phase === "start") {
          const id = `${td.tool}_${assistant!.parts.length}`;
          const tool: ToolCall = {
            id,
            name: td.tool,
            status: "running",
            args: td.args,
            ts: e.ts,
          };
          const part: ChatPart = { kind: "tool", tool };
          toolsById.set(id, part);
          assistant!.parts.push(part);
          textPart = null;
        } else if (td.phase === "end") {
          const parts = [...toolsById.values()].reverse();
          const part = parts.find((p) => p.tool && p.tool.name === td.tool && p.tool.status === "running");
          if (part?.tool) {
            part.tool.status = td.isError ? "failed" : "completed";
            part.tool.result = td.result;
          }
        }
        break;
      }
      case "job.failed": {
        ensureAssistant(e.ts);
        pushSystem("Run failed", (d as any).error, "error", e.ts);
        flushAssistant("done");
        break;
      }
      case "job.cancelled": {
        ensureAssistant(e.ts);
        pushSystem("Run cancelled", undefined, "warn", e.ts);
        flushAssistant("done");
        break;
      }
      case "job.completed": {
        flushAssistant("done");
        break;
      }
      // ignore: queue.enqueued, job.started, job.updated, agent.follow_up, jira.commented
      default:
        break;
    }
  }
  // any pending assistant part is still streaming
  if (assistant) {
    (assistant as ChatMessage).status = "streaming";
    if ((assistant as ChatMessage).parts.length) messages.push(assistant);
  }
  return messages;
}

export function deriveSummary(events: AgentEvent[]): { firstPrompt: string; lastUserText: string } {
  let first = "";
  let last = "";
  for (const e of events) {
    if (e.type === "job.created" && e.data?.prompt) {
      if (!first) first = String(e.data.prompt);
      last = String(e.data.prompt);
    } else if (e.type === "follow_up.queued" && e.data?.prompt) {
      if (!first) first = String(e.data.prompt);
      last = String(e.data.prompt);
    }
  }
  return { firstPrompt: first, lastUserText: last };
}
