import * as React from "react";
import type { ChatMessage, ChatPart } from "@/lib/types";
import { Message, MessageAvatar, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import { Reasoning } from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
  summarizeArgs,
} from "@/components/ai-elements/tool";
import { Loader } from "@/components/ai-elements/loader";
import { cn } from "@/lib/utils";
import { AlertTriangleIcon, InfoIcon, OctagonAlertIcon } from "lucide-react";

export function ChatTurn({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <Message from="user">
        <MessageContent from="user">
          <div className="whitespace-pre-wrap leading-6 text-[14.5px]">
            {message.parts.map((p, i) => (p.kind === "text" ? p.text : "")).join("")}
          </div>
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

function PartRenderer({ part, streaming }: { part: ChatPart; streaming?: boolean }) {
  if (part.kind === "text") {
    if (!part.text && !streaming) return null;
    return <Response streaming={streaming && !part.text}>{part.text || ""}</Response>;
  }
  if (part.kind === "thinking") {
    return <Reasoning isStreaming={streaming}>{part.thinking}</Reasoning>;
  }
  if (part.kind === "tool") {
    const t = part.tool!;
    const args = t.input ?? t.args;
    const summary = summarizeArgs(args);
    const output = t.outputText || t.result || "";
    const errored = t.status === "failed";
    return (
      <Tool status={t.status} defaultOpen={errored}>
        <ToolHeader type={t.name} status={t.status} argsSummary={summary} />
        <ToolContent>
          <ToolInput input={args} />
          <ToolOutput output={output} errored={errored} />
          {!output && t.status !== "completed" && t.status !== "failed" && (
            <div className="px-2 py-1 text-[11.5px] text-muted-foreground italic">
              awaiting output…
            </div>
          )}
        </ToolContent>
      </Tool>
    );
  }
  if (part.kind === "system" && part.system) {
    return <SystemBanner system={part.system} inline />;
  }
  return null;
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
