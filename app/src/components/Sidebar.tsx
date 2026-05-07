import * as React from "react";
import { cn } from "@/lib/utils";
import type { Health, Job } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  PlusIcon,
  MessageSquareIcon,
  CircleIcon,
  CheckCircle2Icon,
  XCircleIcon,
  Loader2Icon,
  ZapIcon,
  RefreshCwIcon,
} from "lucide-react";

export interface SidebarProps {
  jobs: Job[];
  activeJobId?: string | null;
  health: Health | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}

export function Sidebar({ jobs, activeJobId, health, onSelect, onNew, onRefresh }: SidebarProps) {
  return (
    <aside className="hidden md:flex w-[300px] shrink-0 flex-col border-r border-border bg-card/40 backdrop-blur-sm h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3.5 border-b border-border">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
          <ZapIcon className="size-4 text-primary" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-semibold text-[13.5px]">Background Agents</span>
          <span className="text-[10.5px] text-muted-foreground">
            {health?.ok ? "Online" : "Offline"} · {health?.model?.split("/").pop() ?? "—"}
          </span>
        </div>
      </div>

      {/* New chat button */}
      <div className="p-3 border-b border-border">
        <Button onClick={onNew} className="w-full justify-start gap-2" size="sm">
          <PlusIcon className="size-4" />
          New chat
        </Button>
      </div>

      {/* Sessions list */}
      <div className="flex-1 min-h-0">
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Sessions
          </span>
          <button
            onClick={onRefresh}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh"
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        </div>
        <ScrollArea className="h-[calc(100%-2.25rem)] scroll-thin">
          <div className="px-2 pb-2 space-y-0.5">
            {jobs.length === 0 && (
              <div className="px-3 py-6 text-xs text-muted-foreground text-center">
                No sessions yet.
                <br />
                Start a new chat to begin.
              </div>
            )}
            {jobs.map((j) => (
              <SessionItem
                key={j.id}
                job={j}
                active={j.id === activeJobId}
                onClick={() => onSelect(j.id)}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Footer / health */}
      {health && (
        <div className="border-t border-border px-4 py-3 space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Queue</span><span className="font-mono">{health.queue ?? 0}</span>
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Active</span><span className="font-mono">{health.active ?? 0}</span>
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Total jobs</span><span className="font-mono">{health.jobs ?? 0}</span>
          </div>
          {!!health.extensions?.length && (
            <div className="pt-1.5 flex flex-wrap gap-1">
              {health.extensions.map((e) => (
                <Badge key={e.id} variant="muted" className="text-[9.5px] py-0">{e.id}</Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function SessionItem({ job, active, onClick }: { job: Job; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group w-full text-left rounded-md px-2.5 py-2 transition-all",
        "hover:bg-accent/40",
        active && "session-active hover:bg-transparent",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status={job.status} />
        <span className="flex-1 truncate text-[13px] font-medium">
          {job.title || job.id.slice(4, 16)}
        </span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
          {ago(job.createdAt)}
        </span>
      </div>
      <div className="mt-0.5 ml-5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span className="capitalize">{job.status}</span>
        {job.issueKey && <span>· {job.issueKey}</span>}
        {job.model && (
          <span className="font-mono truncate">· {job.model.split("/").pop()}</span>
        )}
      </div>
    </button>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "running") {
    return <Loader2Icon className="size-3 animate-spin text-primary shrink-0" />;
  }
  if (status === "completed") {
    return <CheckCircle2Icon className="size-3 text-emerald-400 shrink-0" />;
  }
  if (status === "failed") {
    return <XCircleIcon className="size-3 text-red-400 shrink-0" />;
  }
  if (status === "queued") {
    return <CircleIcon className="size-3 text-amber-400 shrink-0" />;
  }
  if (status === "cancelled" || status === "interrupted") {
    return <CircleIcon className="size-3 text-muted-foreground shrink-0" />;
  }
  return <MessageSquareIcon className="size-3 text-muted-foreground shrink-0" />;
}

function ago(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
