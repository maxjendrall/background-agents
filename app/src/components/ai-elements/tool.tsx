import * as React from "react";
import {
  ChevronRightIcon,
  CheckIcon,
  XIcon,
  Loader2Icon,
  type LucideIcon,
  WrenchIcon,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolCall, ToolStatus } from "@/lib/types";
import { getToolRenderer } from "@/components/tool-renderers/registry";

function ToolCardImpl({ tool }: { tool: ToolCall }) {
  const renderer = getToolRenderer(tool.name);
  const [open, setOpen] = React.useState<boolean>(Boolean(renderer.defaultOpen) || tool.status === "failed");
  const Icon = renderer.icon || WrenchIcon;
  const title = renderer.title?.(tool) ?? tool.name;
  const argsSummary = renderer.argsSummary?.(tool) ?? null;
  const body = renderer.body?.(tool) ?? null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-status={tool.status}
        className={cn(
          "rounded-lg border overflow-hidden transition-colors",
          tool.status === "failed" ? "border-destructive/40 bg-destructive/5"
            : tool.status === "completed" ? "border-border bg-card/40"
              : "border-primary/30 bg-primary/[0.04]",
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
          >
            <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
            <ToolStatusIcon status={tool.status} />
            <Icon className="size-3.5 text-muted-foreground shrink-0" />
            <span className="font-mono text-[12.5px] font-semibold">{title}</span>
            {argsSummary && (
              <span className="font-mono text-[11.5px] text-muted-foreground truncate min-w-0 flex-1 text-left">
                {argsSummary}
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up overflow-hidden">
          <div className="border-t border-border/60 px-3 py-2.5 space-y-2 bg-background/40">
            {body ?? <DefaultBody tool={tool} />}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/**
 * Skip re-render when the tool's render-affecting fields are unchanged.
 * Inputs are stable once a tool starts; outputs grow during streaming.
 */
function toolFingerprint(t: ToolCall): string {
  return [
    t.id,
    t.name,
    t.status,
    t.outputText?.length ?? 0,
    t.outputImages?.length ?? 0,
    t.input ? Object.keys(t.input).length : 0,
    t.input?.command || t.input?.path || t.input?.file_path || "",
    t.outputDetails ? "d" : "",
  ].join("|");
}

export const ToolCard = React.memo(ToolCardImpl, (prev, next) => {
  if (prev.tool === next.tool) return true;
  return toolFingerprint(prev.tool) === toolFingerprint(next.tool);
});

function DefaultBody({ tool }: { tool: ToolCall }) {
  const input = tool.input;
  const text = tool.outputText || (typeof tool.result === "string" ? tool.result : "") || "";
  const errored = tool.status === "failed";
  return (
    <>
      {input && Object.keys(input).length > 0 && (
        <div className="rounded-md border border-border/60 bg-muted/30 overflow-hidden">
          <div className="px-2.5 py-1 text-[10.5px] uppercase tracking-wide text-muted-foreground font-medium border-b border-border/40">Input</div>
          <pre className="px-3 py-2 text-[11.5px] leading-5 font-mono whitespace-pre-wrap break-words text-foreground/90 max-h-64 overflow-auto scroll-thin">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      {text && (
        <div className={cn("rounded-md border overflow-hidden", errored ? "border-destructive/40 bg-destructive/5" : "border-border/60 bg-muted/30")}>
          <div className="px-2.5 py-1 text-[10.5px] uppercase tracking-wide text-muted-foreground font-medium border-b border-border/40">
            {errored ? "Error" : "Output"}
          </div>
          <pre className="px-3 py-2 text-[11.5px] leading-5 font-mono whitespace-pre-wrap break-words text-foreground/85 max-h-80 overflow-auto scroll-thin">
            {text.slice(0, 8000)}
            {text.length > 8000 && (
              <span className="text-muted-foreground italic">{`\n…(${(text.length - 8000).toLocaleString()} more chars)`}</span>
            )}
          </pre>
        </div>
      )}
      {!input && !text && (
        <div className="text-[11.5px] text-muted-foreground italic">awaiting…</div>
      )}
    </>
  );
}

function ToolStatusIcon({ status }: { status: ToolStatus }) {
  if (status === "completed") {
    return (
      <span className="inline-flex size-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex size-4 items-center justify-center rounded-full bg-red-500/15 text-red-400 ring-1 ring-red-500/30">
        <XIcon className="size-3" />
      </span>
    );
  }
  if (status === "running" || status === "in_progress") {
    return (
      <span className="inline-flex size-4 items-center justify-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/30">
        <Loader2Icon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border">
      <Loader2Icon className="size-3 animate-spin opacity-50" />
    </span>
  );
}
