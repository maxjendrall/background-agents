import * as React from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChatTurn } from "@/components/ChatTurn";
import { Loader } from "@/components/ai-elements/loader";
import { cn } from "@/lib/utils";
import { api, streamEvents } from "@/lib/api";
import { eventsToMessages } from "@/lib/chat";
import type { AgentEvent, Health, Job, ChatMessage } from "@/lib/types";
import {
  SparklesIcon,
  CircleStopIcon,
  RotateCcwIcon,
  HashIcon,
  CpuIcon,
  MessageSquareIcon,
} from "lucide-react";

interface ChatViewProps {
  jobId: string | null;
  health: Health | null;
  onJobCreated?: (id: string) => void;
}

interface NewChatProps {
  health: Health | null;
  onCreated: (id: string) => void;
}

export function NewChatPanel({ health, onCreated }: NewChatProps) {
  const [prompt, setPrompt] = React.useState("");
  const [issueKey, setIssueKey] = React.useState("");
  const [model, setModel] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    try {
      const body: any = { prompt: prompt.trim() };
      if (issueKey.trim()) body.issueKey = issueKey.trim();
      if (model.trim()) body.model = model.trim();
      const res = await api.run(body);
      onCreated(res.job.id);
    } catch (e) {
      alert(String((e as Error).message || e));
    } finally {
      setSubmitting(false);
    }
  }

  const presets = [
    "List the files in the workspace.",
    "Summarize the recent commits in this repo.",
    "Look for TODOs in the codebase.",
    "Open package.json and explain the scripts.",
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 overflow-y-auto scroll-thin">
      <div className="w-full max-w-2xl space-y-8">
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-gradient-to-br from-primary/30 via-primary/15 to-fuchsia-500/30 ring-1 ring-primary/30">
            <SparklesIcon className="size-7 text-primary" />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Start a new agent run
          </h1>
          <p className="text-muted-foreground text-sm max-w-md mx-auto">
            Describe what you want done. The agent will run in the background and stream
            its progress, tool calls, and reasoning back to this chat.
          </p>
        </div>

        <PromptInput onSubmit={submit}>
          <PromptInputTextarea
            value={prompt}
            placeholder="Ask the agent to do something… (Cmd/Ctrl+Enter to send)"
            minRows={2}
            maxRows={12}
            autoFocus
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <PromptInputToolbar>
            <PromptInputTools>
              <div className="flex items-center gap-2 px-1">
                <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <HashIcon className="size-3.5" />
                  <input
                    type="text"
                    placeholder="Jira issue (optional)"
                    value={issueKey}
                    onChange={(e) => setIssueKey(e.target.value)}
                    className="bg-transparent text-foreground placeholder:text-muted-foreground/60 w-32 outline-none focus:placeholder:opacity-40"
                  />
                </label>
                <span className="text-border">|</span>
                <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <CpuIcon className="size-3.5" />
                  <input
                    type="text"
                    placeholder={`Model (${health?.model ?? "default"})`}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="bg-transparent text-foreground placeholder:text-muted-foreground/60 w-44 outline-none focus:placeholder:opacity-40"
                  />
                </label>
              </div>
            </PromptInputTools>
            <PromptInputSubmit
              disabled={!prompt.trim() || submitting}
              status={submitting ? "submitted" : "idle"}
            />
          </PromptInputToolbar>
        </PromptInput>

        <div className="space-y-2.5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            Try one of these
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            {presets.map((p) => (
              <button
                key={p}
                onClick={() => setPrompt(p)}
                className="text-left rounded-lg border border-border bg-card/40 px-3.5 py-2.5 text-sm text-foreground/90 hover:border-primary/40 hover:bg-card transition-colors"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatView({ jobId, health }: ChatViewProps) {
  const [job, setJob] = React.useState<Job | null>(null);
  const [events, setEvents] = React.useState<AgentEvent[]>([]);
  const [followUp, setFollowUp] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  // Load job + open SSE.
  // Streaming events arrive faster than 60Hz; we batch them into a buffer and flush
  // once per animation frame so React doesn't render per-token (which is the main
  // source of flicker on long-running jobs).
  React.useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let close: (() => void) | undefined;
    // Reset state for the new job (otherwise we'd show stale data from a previous chat).
    setFollowUp("");
    setJob(null);
    setEvents([]);
    let pending: AgentEvent[] = [];
    let pendingIds = new Set<string>();
    let raf: number | null = null;
    const flush = () => {
      raf = null;
      if (!pending.length) return;
      const toAdd = pending;
      pending = [];
      pendingIds = new Set();
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const fresh = toAdd.filter((e) => !seen.has(e.id));
        if (!fresh.length) return prev;
        return prev.concat(fresh);
      });
    };
    const schedule = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(flush);
    };

    (async () => {
      try {
        const r = await api.job(jobId, true);
        if (cancelled) return;
        setJob(r.job);
        setEvents(r.job.events || []);
      } catch (e) {
        console.error(e);
      }
      if (cancelled) return;
      close = streamEvents(jobId, (e) => {
        if (pendingIds.has(e.id)) return;
        pendingIds.add(e.id);
        pending.push(e);
        // Job-status transitions affect the header — don't batch those.
        if (e.type === "job.completed" || e.type === "job.failed" || e.type === "job.cancelled") {
          api.job(jobId).then((r) => setJob(r.job)).catch(() => {});
        }
        if (e.type === "job.updated" && e.data) {
          // The /api/jobs/:id/events SSE includes job.updated with the full pub() payload.
          setJob((j) => (j ? { ...j, ...(e.data as any) } : j));
        }
        schedule();
      });
    })();
    return () => {
      cancelled = true;
      if (raf != null) cancelAnimationFrame(raf);
      close?.();
    };
  }, [jobId]);


  const messages = React.useMemo<ChatMessage[]>(() => eventsToMessages(events), [events]);
  const isRunning = job?.status === "running" || job?.status === "queued";

  // Stable callbacks so the prompt input + buttons don't get a fresh reference each render.
  const onCancel = React.useCallback(() => {
    if (jobId) api.cancel(jobId);
  }, [jobId]);
  const onReset = React.useCallback(async () => {
    if (!jobId) return;
    if (!confirm("Reset this session? This clears the agent's memory and event history.")) return;
    await api.reset(jobId);
    const r = await api.job(jobId, true);
    setJob(r.job);
    setEvents(r.job.events || []);
  }, [jobId]);

  async function sendFollowUp(e?: React.FormEvent) {
    e?.preventDefault();
    if (!jobId || !followUp.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.prompt(jobId, followUp.trim());
      setFollowUp("");
    } catch (err) {
      alert(String((err as Error).message || err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!jobId || !job) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-6 py-3 bg-card/30 backdrop-blur-sm">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
          <MessageSquareIcon className="size-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="font-semibold text-[14.5px] truncate">
              {job.title || job.id.slice(4, 16)}
            </h2>
            <StatusBadge status={job.status} />
            {job.issueKey && <Badge variant="outline">{job.issueKey}</Badge>}
          </div>
          <div className="text-[11.5px] text-muted-foreground font-mono truncate">
            {job.id} {job.model ? `· ${job.model}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {isRunning && (
            <Button size="sm" variant="outline" onClick={onCancel}>
              <CircleStopIcon className="size-3.5" /> Cancel
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onReset}>
            <RotateCcwIcon className="size-3.5" /> Reset
          </Button>
        </div>
      </div>

      {/* Conversation */}
      <Conversation className="flex-1 min-h-0">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<MessageSquareIcon className="size-8" />}
              title="Waiting for the agent…"
              description="The conversation will start populating once the agent begins responding."
            />
          ) : (
            messages.map((m) => <ChatTurn key={m.id} message={m} />)
          )}
          {job.error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <div className="font-semibold mb-1">Run failed</div>
              <div className="font-mono text-xs whitespace-pre-wrap break-words">{job.error}</div>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Follow-up input */}
      <div className="border-t border-border bg-background/80 backdrop-blur px-6 py-4">
        <div className="max-w-3xl mx-auto">
          <PromptInput onSubmit={sendFollowUp}>
            <PromptInputTextarea
              value={followUp}
              placeholder={
                isRunning
                  ? "Agent is working… (you can queue a follow-up)"
                  : "Send a follow-up message…"
              }
              minRows={1}
              maxRows={8}
              onChange={(e) => setFollowUp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendFollowUp();
                }
              }}
            />
            <PromptInputToolbar>
              <PromptInputTools>
                <span className="px-1 text-[10.5px] text-muted-foreground">
                  Enter to send · Shift+Enter for newline
                </span>
              </PromptInputTools>
              <PromptInputSubmit
                disabled={!followUp.trim() || submitting}
                status={isRunning ? "streaming" : submitting ? "submitted" : "idle"}
              />
            </PromptInputToolbar>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "completed" ? "success"
      : status === "running" ? "default"
      : status === "queued" ? "warn"
      : status === "failed" ? "danger"
      : "muted";
  return (
    <Badge variant={variant as any}>
      <span className={cn(
        "size-1.5 rounded-full",
        status === "completed" && "bg-emerald-400",
        status === "running" && "bg-primary animate-pulse",
        status === "queued" && "bg-amber-400 animate-pulse",
        status === "failed" && "bg-red-400",
        (status === "cancelled" || status === "interrupted" || status === "idle") && "bg-muted-foreground",
      )} />
      {status}
    </Badge>
  );
}
