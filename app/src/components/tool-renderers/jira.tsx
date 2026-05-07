import { Response } from "@/components/ai-elements/response";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ExternalLinkIcon,
  PaperclipIcon,
  MessageSquareIcon,
  ListIcon,
  TagIcon,
} from "lucide-react";

const JIRA_CLOUD = "https://petsdeli.atlassian.net";

function issueUrl(key: string) {
  return `${JIRA_CLOUD}/browse/${encodeURIComponent(key)}`;
}

function statusVariant(status: string): "success" | "warn" | "danger" | "default" | "muted" {
  const s = (status || "").toLowerCase();
  if (s.includes("done") || s.includes("closed") || s.includes("resolved")) return "success";
  if (s.includes("progress") || s.includes("review") || s.includes("testing")) return "default";
  if (s.includes("blocked") || s.includes("rejected")) return "danger";
  if (s.includes("open") || s.includes("backlog") || s.includes("todo")) return "warn";
  return "muted";
}

/**
 * jira_get_issue → markdown like:
 *
 *   # PT-9142: FE :: Add personalized content block...
 *   - **Status**: Open
 *   - **Priority**: Medium 2
 *   ...
 *   ## Description
 *   ...
 */
export function JiraIssueRenderer({ output }: { output: string }) {
  const meta = parseIssueMeta(output);
  if (!meta) return <Response>{output}</Response>;
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.04] overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-3 border-b border-border/60 bg-card/40">
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={issueUrl(meta.key)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[12.5px] font-semibold text-primary hover:underline inline-flex items-center gap-1"
            >
              {meta.key}
              <ExternalLinkIcon className="size-3" />
            </a>
            {meta.status && <Badge variant={statusVariant(meta.status)}>{meta.status}</Badge>}
            {meta.priority && <Badge variant="muted">{meta.priority}</Badge>}
            {meta.type && <Badge variant="outline">{meta.type}</Badge>}
          </div>
          {meta.summary && (
            <h3 className="text-[14.5px] font-semibold leading-snug text-foreground">{meta.summary}</h3>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {meta.assignee && <span><span className="opacity-70">Assignee:</span> {meta.assignee}</span>}
            {meta.reporter && <span><span className="opacity-70">Reporter:</span> {meta.reporter}</span>}
            {meta.labels && meta.labels !== "none" && (
              <span className="inline-flex items-center gap-1">
                <TagIcon className="size-3" /> {meta.labels}
              </span>
            )}
            {meta.attachments && (
              <span className="inline-flex items-center gap-1">
                <PaperclipIcon className="size-3" /> {meta.attachments} attachment{meta.attachments === "1" ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </div>
      {meta.description && (
        <div className="px-4 py-3">
          <Response>{meta.description}</Response>
        </div>
      )}
    </div>
  );
}

interface IssueMeta {
  key: string;
  summary?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  type?: string;
  labels?: string;
  attachments?: string;
  description?: string;
}

function parseIssueMeta(text: string): IssueMeta | null {
  // Title pattern: "# PT-1234: Summary"
  const titleMatch = text.match(/^#\s+([A-Z][A-Z0-9_]*-\d+)\s*:\s*(.*)$/m);
  if (!titleMatch) return null;
  const meta: IssueMeta = { key: titleMatch[1], summary: titleMatch[2].trim() };
  const fields: Record<string, keyof IssueMeta> = {
    Status: "status",
    Priority: "priority",
    Assignee: "assignee",
    Reporter: "reporter",
    Type: "type",
    Labels: "labels",
    Attachments: "attachments",
  };
  for (const [name, key] of Object.entries(fields)) {
    const m = text.match(new RegExp(`^-\\s+\\*\\*${name}\\*\\*\\s*:\\s*(.+)$`, "m"));
    if (m) (meta as any)[key] = m[1].trim();
  }
  const desc = text.match(/##\s+Description\s*\n+([\s\S]*)$/);
  if (desc) meta.description = desc[1].trim();
  return meta;
}

/**
 * jira_get_comments output format:
 *   **Author** (2026-04-17 09:30):
 *   body...
 *
 *   ---
 *
 *   **Author2** (...)
 *   body
 */
export function JiraCommentsRenderer({ output, issueKey }: { output: string; issueKey?: string }) {
  if (output.trim() === "(no comments)") {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground inline-flex items-center gap-2">
        <MessageSquareIcon className="size-4" /> No comments
      </div>
    );
  }
  const blocks = output.split(/\n+---\n+/);
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => {
        const m = b.match(/^\*\*(.+?)\*\*\s*\(([^)]+)\):\s*\n([\s\S]*)$/);
        if (!m) return <Response key={i}>{b}</Response>;
        const [, author, ts, body] = m;
        return (
          <div key={i} className="rounded-lg border border-border bg-card/40 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 border-b border-border/60">
              <div className="size-6 rounded-full bg-gradient-to-br from-primary/40 to-fuchsia-500/30 ring-1 ring-primary/30 flex items-center justify-center text-[10px] font-bold text-primary">
                {author.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase()}
              </div>
              <span className="text-[12.5px] font-medium">{author}</span>
              <span className="text-[10.5px] text-muted-foreground tabular-nums ml-auto">{ts}</span>
            </div>
            <div className="px-4 py-2.5">
              <Response>{body.trim()}</Response>
            </div>
          </div>
        );
      })}
      {issueKey && (
        <a
          href={issueUrl(issueKey)}
          target="_blank"
          rel="noreferrer"
          className="text-[11.5px] text-primary hover:underline inline-flex items-center gap-1 ml-1"
        >
          View in Jira <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </div>
  );
}

/**
 * jira_search / jira_board_search output format:
 *   - **PT-1234**: Summary [Status] (assignee)
 *   - **PT-2345**: ...
 */
export function JiraSearchRenderer({ output }: { output: string }) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = lines
    .map((l) => l.match(/^-\s+\*\*([A-Z][A-Z0-9_]*-\d+)\*\*:\s*(.+?)(?:\s+\[(.+?)\])?(?:\s+\((.+?)\))?$/))
    .filter(Boolean) as RegExpMatchArray[];
  if (!items.length) return <Response>{output}</Response>;
  return (
    <div className="rounded-lg border border-border bg-card/30 overflow-hidden">
      <div className="px-3 py-1.5 bg-muted/40 border-b border-border/60 text-[10.5px] uppercase tracking-wide text-muted-foreground font-medium inline-flex items-center gap-1.5">
        <ListIcon className="size-3" /> {items.length} issue{items.length === 1 ? "" : "s"}
      </div>
      <ul className="divide-y divide-border/50">
        {items.map((m, i) => {
          const [, key, summary, status, assignee] = m;
          return (
            <li key={i} className="flex items-center gap-2 px-3 py-2 hover:bg-accent/20 transition-colors">
              <a
                href={issueUrl(key)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[12px] font-semibold text-primary hover:underline shrink-0"
              >
                {key}
              </a>
              <span className="flex-1 truncate text-[13px]">{summary}</span>
              {status && <Badge variant={statusVariant(status)} className="shrink-0">{status}</Badge>}
              {assignee && <span className="text-[10.5px] text-muted-foreground shrink-0 truncate max-w-[140px]">{assignee}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * jira_list_transitions: lines of "- **Name** (id: 11)"
 */
export function JiraTransitionsRenderer({ output }: { output: string }) {
  const items = (output.match(/^-\s+\*\*(.+?)\*\*\s+\(id:\s+(\d+)\)/gm) || []).map((l) => {
    const m = l.match(/^-\s+\*\*(.+?)\*\*\s+\(id:\s+(\d+)\)/)!;
    return { name: m[1], id: m[2] };
  });
  if (!items.length) return <Response>{output}</Response>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t) => (
        <Badge key={t.id} variant="outline" className="text-[11px] py-1 px-2.5 normal-case">
          {t.name} <span className="opacity-60 ml-1">#{t.id}</span>
        </Badge>
      ))}
    </div>
  );
}

/**
 * jira_add_comment confirmation
 */
export function JiraCommentAddedRenderer({ input, output }: { input: any; output: string }) {
  const issueKey = input?.issueKey;
  const comment = input?.comment;
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 text-[11.5px] font-medium">
        <MessageSquareIcon className="size-3.5" />
        <span>Comment added{issueKey ? ` to ` : ""}</span>
        {issueKey && (
          <a href={issueUrl(issueKey)} target="_blank" rel="noreferrer" className="font-mono font-semibold hover:underline inline-flex items-center gap-1">
            {issueKey} <ExternalLinkIcon className="size-3" />
          </a>
        )}
      </div>
      {comment && (
        <div className="px-4 py-2.5 max-h-72 overflow-auto scroll-thin">
          <Response>{comment}</Response>
        </div>
      )}
    </div>
  );
}
