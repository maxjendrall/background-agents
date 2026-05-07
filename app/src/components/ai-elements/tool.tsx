import * as React from "react";
import {
  ChevronRightIcon,
  CheckIcon,
  XIcon,
  WrenchIcon,
  Loader2Icon,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolStatus } from "@/lib/types";

export interface ToolProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean;
  status?: ToolStatus;
}

export const Tool = ({ className, defaultOpen, status, children, ...props }: ToolProps) => {
  const [open, setOpen] = React.useState(Boolean(defaultOpen));
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-status={status}
        className={cn(
          "rounded-lg border bg-card/40 overflow-hidden transition-colors",
          status === "failed" ? "border-destructive/40 bg-destructive/5"
            : status === "completed" ? "border-border"
            : "border-primary/30 bg-primary/[0.04]",
          className,
        )}
        {...props}
      >
        {React.Children.map(children, (child) => {
          if (!React.isValidElement(child)) return child;
          if ((child.type as any) === ToolHeader) return React.cloneElement(child as React.ReactElement<any>, { open });
          return child;
        })}
      </div>
    </Collapsible>
  );
};

export interface ToolHeaderProps extends React.HTMLAttributes<HTMLButtonElement> {
  type: string;
  status: ToolStatus;
  argsSummary?: string;
  open?: boolean;
}

export const ToolHeader = ({
  type,
  status,
  argsSummary,
  className,
  open,
  ...props
}: ToolHeaderProps) => {
  return (
    <CollapsibleTrigger asChild>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
          "hover:bg-accent/30",
          className,
        )}
        {...props}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <ToolStatusIcon status={status} />
        <span className="font-mono text-[12.5px] font-semibold">{type}</span>
        {argsSummary && (
          <span className="font-mono text-[11.5px] text-muted-foreground truncate min-w-0 flex-1">
            {argsSummary}
          </span>
        )}
      </button>
    </CollapsibleTrigger>
  );
};

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
      <WrenchIcon className="size-2.5" />
    </span>
  );
}

export const ToolContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <CollapsibleContent className="data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up overflow-hidden">
    <div className={cn("border-t border-border/60 px-3 py-2 space-y-2 bg-background/40", className)} {...props} />
  </CollapsibleContent>
);

export const ToolInput = ({ input, className }: { input?: any; className?: string }) => {
  if (input == null || (typeof input === "object" && Object.keys(input).length === 0)) return null;
  const json = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return (
    <div className={cn("rounded-md border border-border/60 bg-muted/30 overflow-hidden", className)}>
      <div className="px-2.5 py-1 text-[10.5px] uppercase tracking-wide text-muted-foreground font-medium border-b border-border/40">
        Input
      </div>
      <pre className="px-3 py-2 text-[11.5px] leading-5 font-mono whitespace-pre-wrap break-words text-foreground/90 max-h-64 overflow-auto scroll-thin">
        {json}
      </pre>
    </div>
  );
};

// @ts-expect-error - no types for ansi-to-react
import Ansi from "ansi-to-react";

export const ToolOutput = ({ output, errored }: { output?: string; errored?: boolean }) => {
  if (!output) return null;
  const truncated = output.slice(0, 8000);
  const overflow = output.length - truncated.length;
  return (
    <div className={cn("rounded-md border overflow-hidden",
      errored ? "border-destructive/40 bg-destructive/5" : "border-border/60 bg-muted/30",
    )}>
      <div className="px-2.5 py-1 text-[10.5px] uppercase tracking-wide text-muted-foreground font-medium border-b border-border/40">
        {errored ? "Error" : "Output"}
      </div>
      <pre className="px-3 py-2 text-[11.5px] leading-5 font-mono whitespace-pre-wrap break-words text-foreground/85 max-h-80 overflow-auto scroll-thin">
        <Ansi useClasses={false}>{truncated}</Ansi>
        {overflow > 0 && (
          <span className="text-muted-foreground italic">{`\n…(${overflow} more chars)`}</span>
        )}
      </pre>
    </div>
  );
};

export function summarizeArgs(input: any): string {
  if (!input || typeof input !== "object") return "";
  const o = input;
  if (typeof o.command === "string") return o.command;
  if (typeof o.path === "string") return o.path;
  if (typeof o.file_path === "string") return o.file_path;
  if (typeof o.issueKey === "string") return o.issueKey;
  if (typeof o.jql === "string") return o.jql;
  if (typeof o.query === "string") return o.query;
  if (typeof o.pattern === "string") return o.pattern;
  if (typeof o.url === "string") return o.url;
  const keys = Object.keys(o);
  if (!keys.length) return "";
  return keys
    .slice(0, 3)
    .map((k) => {
      const v = o[k];
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${(s || "").slice(0, 40)}`;
    })
    .join(" ");
}
