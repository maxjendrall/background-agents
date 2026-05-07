import * as React from "react";
import type { ChatMessage, ChatPart } from "@/lib/types";
import { Message, MessageAvatar, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { ToolCard } from "@/components/ai-elements/tool";
import { Loader } from "@/components/ai-elements/loader";
import { cn } from "@/lib/utils";
import { AlertTriangleIcon, InfoIcon, OctagonAlertIcon } from "lucide-react";

function ChatTurnImpl({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    return (
      <Message from="user">
        <MessageContent from="user">
          <CollapsibleUserText text={text} />
        </MessageContent>
        <MessageAvatar from="user" />
      </Message>
    );
  }

  if (message.role === "system") {
    const sysPart = message.parts.find((p) => p.kind === "system");
    if (!sysPart?.system) return null;
    return <SystemBanner system={sysPart.system} />;
  }

  // assistant
  const isStreaming = message.status === "streaming";
  return (
    <Message from="assistant">
      <MessageAvatar from="assistant" />
      <MessageContent from="assistant">
        {message.parts.map((p, i) => (
          <PartRenderer key={i} part={p} streaming={isStreaming && i === message.parts.length - 1} />
        ))}
        {isStreaming && message.parts.length === 0 && (
          <div className="text-muted-foreground text-sm flex items-center gap-2">
            <Loader />
            <span>Working…</span>
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

/**
 * Custom equality:
 *   - if both messages are "done" with identical parts identity, skip render.
 *   - assistant messages that are still streaming need to re-render whenever any
 *     of their parts changes (text, tool status/output, thinking).
 *
 * Note: `eventsToMessages` mutates parts in place across rebuilds (it stores them
 * in maps + arrays from a fresh closure). So we compare a structural fingerprint
 * rather than reference identity.
 */
function fingerprintMessage(m: ChatMessage): string {
  const fp: string[] = [m.id, m.role, m.status || "", String(m.parts.length)];
  for (const p of m.parts) {
    if (p.kind === "text") fp.push("t" + (p.text?.length ?? 0));
    else if (p.kind === "thinking") fp.push("h" + (p.thinking?.length ?? 0));
    else if (p.kind === "tool" && p.tool) {
      const t = p.tool;
      fp.push(
        "k" + t.id + ":" + t.status +
        ":" + (t.outputText?.length ?? 0) +
        ":" + (t.outputImages?.length ?? 0) +
        ":" + (t.input ? Object.keys(t.input).length : 0),
      );
    } else if (p.kind === "system" && p.system) {
      fp.push("s" + p.system.label);
    }
  }
  return fp.join("|");
}

export const ChatTurn = React.memo(ChatTurnImpl, (prev, next) => {
  if (prev.message === next.message) return true;
  return fingerprintMessage(prev.message) === fingerprintMessage(next.message);
});

function PartRenderer({ part, streaming }: { part: ChatPart; streaming?: boolean }) {
  if (part.kind === "text") {
    if (!part.text && !streaming) return null;
    return <Response streaming={streaming && !part.text}>{part.text || ""}</Response>;
  }
  if (part.kind === "thinking") {
    return <Reasoning isStreaming={streaming}>{part.thinking}</Reasoning>;
  }
  if (part.kind === "tool") {
    return <ToolCard tool={part.tool!} />;
  }
  if (part.kind === "system" && part.system) {
    return <SystemBanner system={part.system} inline />;
  }
  return null;
}

/**
 * For Jira-triggered runs the user "message" is the whole prompt the server built
 * from the issue + comments + rules — too long to dump verbatim. Show only the head
 * by default with an inline expand control.
 */
function CollapsibleUserText({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  // Strip the "[CONTEXT] ... [NEW MESSAGE] <real>" prefix so collapsed view doesn't show server scaffolding.
  let displayText = text;
  const newMsgIdx = text.indexOf("[NEW MESSAGE]");
  if (text.startsWith("[CONTEXT]") && newMsgIdx >= 0) {
    displayText = text.slice(newMsgIdx + "[NEW MESSAGE]".length).trimStart();
  }
  const lines = displayText.split("\n");
  const tooLong = lines.length > 12 || displayText.length > 900;
  if (!tooLong) {
    return (
      <div className="whitespace-pre-wrap leading-6 text-[14.5px]">{displayText}</div>
    );
  }
  // Look for the "## What just happened" block — actual user-intent for Jira runs.
  let head = "";
  const m = displayText.match(/##\s+What just happened[^\n]*\n+([\s\S]*?)(?:\n+##\s|$)/);
  if (m) {
    head = m[1].trim();
  } else {
    head = lines.slice(0, 6).join("\n");
  }
  return (
    <div className="space-y-2">
      <div className={cn("whitespace-pre-wrap leading-6 text-[14.5px]", !open && "max-h-[18em] overflow-hidden relative")}>
        {open ? displayText : head}
      </div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "text-[11px] font-medium uppercase tracking-wide rounded-md px-2 py-1 transition-colors",
          "bg-primary-foreground/10 hover:bg-primary-foreground/20 text-primary-foreground/80",
        )}
      >
        {open ? "Show less" : `Show full prompt (${lines.length} lines)`}
      </button>
    </div>
  );
}

function SystemBanner({
  system,
  inline,
}: {
  system: NonNullable<ChatPart["system"]>;
  inline?: boolean;
}) {
  const Icon =
    system.tone === "error"
      ? OctagonAlertIcon
      : system.tone === "warn"
        ? AlertTriangleIcon
        : InfoIcon;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px]",
        inline ? "self-start max-w-fit" : "mx-auto max-w-fit",
        system.tone === "error" && "bg-destructive/10 text-destructive ring-1 ring-destructive/30",
        system.tone === "warn" && "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/30",
        (!system.tone || system.tone === "info") &&
          "bg-muted/40 text-muted-foreground ring-1 ring-border/60",
      )}
    >
      <Icon className="size-3.5" />
      <span className="font-medium">{system.label}</span>
      {system.detail && <span className="opacity-75 font-mono text-[11px]">· {system.detail}</span>}
    </div>
  );
}
