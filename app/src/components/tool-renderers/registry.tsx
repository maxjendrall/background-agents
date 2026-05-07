import * as React from "react";
import {
  TerminalIcon,
  FileTextIcon,
  FileEditIcon,
  FilePlusIcon,
  SearchIcon,
  FolderIcon,
  ImageIcon,
  GlobeIcon,
  PlayIcon,
  Wrench,
  ListChecksIcon,
  type LucideIcon,
} from "lucide-react";
import type { ToolCall } from "@/lib/types";
import { TerminalBlock, FileViewer, FileList, JsonBlock, KeyValueGrid, StatusOnly, inferLanguage } from "./common";
import { DiffRenderer, synthesizeEditDiff } from "./diff";
import {
  JiraIssueRenderer,
  JiraCommentsRenderer,
  JiraSearchRenderer,
  JiraTransitionsRenderer,
  JiraCommentAddedRenderer,
} from "./jira";
import { ImageRenderer } from "./image";
import {
  GitStatusRenderer,
  GitDiffRenderer,
  GitLogRenderer,
  GitCommitRenderer,
  GitPushRenderer,
  GitHubPRRenderer,
} from "./git";

export interface ToolRenderProps {
  tool: ToolCall;
}

interface ToolRenderer {
  icon: LucideIcon;
  // short title shown in header (defaults to tool name)
  title?: (tool: ToolCall) => string;
  // short summary line beside title (e.g. file path / command)
  argsSummary?: (tool: ToolCall) => string | null;
  // render the body when expanded; return null to use default (input + output text)
  body?: (tool: ToolCall) => React.ReactNode;
  // if true, body should be shown without the input/output collapse wrapper
  inlineBody?: boolean;
  // default-open the details
  defaultOpen?: boolean;
}

const FILE_PATH_KEY = ["file_path", "filePath", "path", "filename"];

function pickPath(input: any): string | undefined {
  if (!input || typeof input !== "object") return;
  for (const k of FILE_PATH_KEY) if (typeof input[k] === "string") return input[k];
  return undefined;
}

function basename(p?: string) {
  if (!p) return "";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function getOutputText(tool: ToolCall): string {
  return tool.outputText || (typeof tool.result === "string" ? tool.result : "") || "";
}

const REGISTRY: Record<string, ToolRenderer> = {
  // --- Pi built-ins ---
  bash: {
    icon: TerminalIcon,
    title: () => "bash",
    argsSummary: (t) => (t.input?.command ? String(t.input.command) : null),
    body: (t) => <TerminalBlock command={t.input?.command} output={getOutputText(t)} errored={t.status === "failed"} />,
    inlineBody: true,
  },
  read: {
    icon: FileTextIcon,
    title: (t) => `read ${basename(pickPath(t.input))}`,
    argsSummary: (t) => pickPath(t.input) || null,
    body: (t) => <FileViewer path={pickPath(t.input)} content={getOutputText(t)} language={inferLanguage(pickPath(t.input))} />,
    inlineBody: true,
  },
  write: {
    icon: FilePlusIcon,
    title: (t) => `write ${basename(pickPath(t.input))}`,
    argsSummary: (t) => pickPath(t.input) || null,
    body: (t) => {
      const path = pickPath(t.input);
      const content = t.input?.content || t.input?.text || "";
      return (
        <div className="space-y-2">
          <StatusOnly text={getOutputText(t) || `Wrote ${path}`} tone={t.status === "failed" ? "error" : "success"} />
          {content && <FileViewer path={path} content={String(content)} language={inferLanguage(path)} />}
        </div>
      );
    },
    inlineBody: true,
  },
  edit: {
    icon: FileEditIcon,
    title: (t) => `edit ${basename(pickPath(t.input))}`,
    argsSummary: (t) => pickPath(t.input) || null,
    body: (t) => {
      const path = pickPath(t.input);
      const oldText = t.input?.oldText ?? t.input?.old_text ?? "";
      const newText = t.input?.newText ?? t.input?.new_text ?? "";
      const diff = path && (oldText || newText) ? synthesizeEditDiff({ path, oldText, newText }) : "";
      return (
        <div className="space-y-2">
          {diff ? (
            <DiffRenderer diff={diff} />
          ) : (
            <StatusOnly text={getOutputText(t) || "Edited"} tone={t.status === "failed" ? "error" : "success"} />
          )}
          {t.status === "failed" && <StatusOnly text={getOutputText(t)} tone="error" />}
        </div>
      );
    },
    inlineBody: true,
    defaultOpen: true,
  },
  grep: {
    icon: SearchIcon,
    title: () => "grep",
    argsSummary: (t) => t.input?.pattern || t.input?.query || null,
    body: (t) => {
      const out = getOutputText(t);
      const lines = out.split("\n").filter(Boolean);
      // grep prints as "path:line:text"
      if (lines.every((l) => /^[^:]+:\d+:/.test(l))) {
        return <FileList paths={lines} icon="search" />;
      }
      return <pre className="font-mono text-[11.5px] whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 px-3 py-2 max-h-72 overflow-auto scroll-thin">{out}</pre>;
    },
    inlineBody: true,
  },
  find: {
    icon: SearchIcon,
    title: () => "find",
    argsSummary: (t) => t.input?.name || t.input?.path || null,
    body: (t) => {
      const out = getOutputText(t);
      const paths = out.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!paths.length) return <StatusOnly text="(no matches)" tone="warn" />;
      return <FileList paths={paths} icon="search" />;
    },
    inlineBody: true,
  },
  ls: {
    icon: FolderIcon,
    title: () => "ls",
    argsSummary: (t) => t.input?.path || null,
    body: (t) => {
      const out = getOutputText(t);
      const paths = out.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!paths.length) return <StatusOnly text="(empty)" tone="warn" />;
      return <FileList paths={paths} icon="tree" />;
    },
    inlineBody: true,
  },
  view_image: {
    icon: ImageIcon,
    title: () => "view_image",
    argsSummary: (t) => basename(pickPath(t.input) || t.outputDetails?.path) || null,
    body: (t) => {
      const path = pickPath(t.input) || t.outputDetails?.path;
      const caption = path ? basename(path) : undefined;
      if (t.outputImages?.length) {
        return <ImageRenderer images={t.outputImages} caption={caption} />;
      }
      return <StatusOnly text={getOutputText(t) || "no image"} tone={t.status === "failed" ? "error" : "warn"} />;
    },
    inlineBody: true,
    defaultOpen: true,
  },

  // --- Jira ---
  jira_get_issue: {
    icon: ListChecksIcon,
    title: (t) => t.input?.issueKey ? `jira ${t.input.issueKey}` : "jira_get_issue",
    argsSummary: (t) => t.input?.issueKey || null,
    body: (t) => <JiraIssueRenderer output={getOutputText(t)} />,
    inlineBody: true,
    defaultOpen: true,
  },
  jira_get_comments: {
    icon: ListChecksIcon,
    title: (t) => `jira comments ${t.input?.issueKey || ""}`.trim(),
    argsSummary: (t) => t.input?.issueKey || null,
    body: (t) => <JiraCommentsRenderer output={getOutputText(t)} issueKey={t.input?.issueKey} />,
    inlineBody: true,
  },
  jira_search: {
    icon: SearchIcon,
    title: () => "jira_search",
    argsSummary: (t) => t.input?.jql || null,
    body: (t) => <JiraSearchRenderer output={getOutputText(t)} />,
    inlineBody: true,
  },
  jira_board_search: {
    icon: SearchIcon,
    title: () => "jira board_search",
    argsSummary: (t) => `${t.input?.board || ""} ${t.input?.jql || ""}`.trim() || null,
    body: (t) => <JiraSearchRenderer output={getOutputText(t)} />,
    inlineBody: true,
  },
  jira_list_transitions: {
    icon: ListChecksIcon,
    title: (t) => `transitions ${t.input?.issueKey || ""}`.trim(),
    argsSummary: (t) => t.input?.issueKey || null,
    body: (t) => <JiraTransitionsRenderer output={getOutputText(t)} />,
    inlineBody: true,
  },
  jira_transition_issue: {
    icon: ListChecksIcon,
    title: (t) => `transition ${t.input?.issueKey || ""}`.trim(),
    argsSummary: (t) => `${t.input?.issueKey || ""} → ${t.input?.transitionId || ""}`.trim() || null,
    body: (t) => <StatusOnly text={getOutputText(t) || "Transitioned"} tone={t.status === "failed" ? "error" : "success"} />,
    inlineBody: true,
  },
  jira_add_comment: {
    icon: ListChecksIcon,
    title: (t) => `comment on ${t.input?.issueKey || ""}`.trim(),
    argsSummary: (t) => t.input?.issueKey || null,
    body: (t) => <JiraCommentAddedRenderer input={t.input} output={getOutputText(t)} />,
    inlineBody: true,
    defaultOpen: true,
  },
  jira_list_attachments: {
    icon: ListChecksIcon,
    title: (t) => `attachments ${t.input?.issueKey || ""}`.trim(),
    argsSummary: (t) => t.input?.issueKey || null,
    body: (t) => {
      const txt = getOutputText(t);
      // Try to render as JSON list if it's JSON
      try {
        const parsed = JSON.parse(txt);
        if (Array.isArray(parsed)) {
          return (
            <ul className="rounded-lg border border-border bg-card/30 divide-y divide-border/40">
              {parsed.map((a: any, i: number) => (
                <li key={i} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                  <ImageIcon className="size-3.5 text-muted-foreground" />
                  <span className="font-mono truncate flex-1">{a.filename || a.name || a.id}</span>
                  <span className="text-[10.5px] text-muted-foreground">{a.mimeType || ""}</span>
                  {a.size && <span className="text-[10.5px] text-muted-foreground tabular-nums">{Math.round(a.size / 1024)}KB</span>}
                </li>
              ))}
            </ul>
          );
        }
      } catch {}
      return <pre className="font-mono text-[11.5px] whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 px-3 py-2 max-h-72 overflow-auto scroll-thin">{txt}</pre>;
    },
    inlineBody: true,
  },
  jira_download_attachment: {
    icon: ImageIcon,
    title: () => "jira_download_attachment",
    argsSummary: (t) => t.input?.attachmentId || null,
    body: (t) => {
      const txt = getOutputText(t);
      try {
        const parsed = JSON.parse(txt);
        return (
          <KeyValueGrid items={[
            { label: "File", value: parsed.filename || "" },
            { label: "Path", value: parsed.vmPath || parsed.path || "" },
            { label: "Type", value: parsed.mimeType || "" },
            { label: "Size", value: parsed.size ? `${Math.round(parsed.size / 1024)} KB` : "" },
          ]} />
        );
      } catch {
        return <StatusOnly text={txt} />;
      }
    },
    inlineBody: true,
  },

  // --- Git ---
  git_status: {
    icon: Wrench,
    title: () => "git_status",
    argsSummary: (t) => basename(t.input?.path) || null,
    body: (t) => <GitStatusRenderer output={getOutputText(t)} />,
    inlineBody: true,
  },
  git_diff: {
    icon: FileEditIcon,
    title: () => "git_diff",
    argsSummary: (t) => basename(t.input?.path) || null,
    body: (t) => <GitDiffRenderer output={getOutputText(t)} />,
    inlineBody: true,
    defaultOpen: true,
  },
  git_commit: {
    icon: Wrench,
    title: () => "git_commit",
    argsSummary: (t) => t.input?.message?.slice(0, 80) || null,
    body: (t) => <GitCommitRenderer output={getOutputText(t)} />,
    inlineBody: true,
    defaultOpen: true,
  },
  git_push: {
    icon: Wrench,
    title: () => "git_push",
    argsSummary: (t) => basename(t.input?.path) || null,
    body: (t) => <GitPushRenderer output={getOutputText(t)} />,
    inlineBody: true,
    defaultOpen: true,
  },
  git_log: {
    icon: Wrench,
    title: () => "git_log",
    argsSummary: (t) => basename(t.input?.path) || null,
    body: (t) => <GitLogRenderer output={getOutputText(t)} />,
    inlineBody: true,
  },

  // --- GitHub ---
  gh_pr_create: {
    icon: Wrench,
    title: () => "gh_pr_create",
    argsSummary: (t) => t.input?.title?.slice(0, 80) || t.input?.head || null,
    body: (t) => <GitHubPRRenderer output={getOutputText(t)} />,
    inlineBody: true,
    defaultOpen: true,
  },

  // --- Browser ---
  browser_fetch: {
    icon: GlobeIcon,
    title: () => "browser_fetch",
    argsSummary: (t) => t.input?.url || null,
    body: (t) => {
      const txt = getOutputText(t);
      return <pre className="font-mono text-[11.5px] whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 px-3 py-2 max-h-72 overflow-auto scroll-thin">{txt.slice(0, 4000)}</pre>;
    },
    inlineBody: true,
  },
  browser_screenshot: {
    icon: ImageIcon,
    title: () => "browser_screenshot",
    argsSummary: (t) => t.input?.url || null,
    body: (t) => {
      if (t.outputImages?.length) return <ImageRenderer images={t.outputImages} caption={t.input?.url} />;
      return <StatusOnly text={getOutputText(t)} />;
    },
    inlineBody: true,
    defaultOpen: true,
  },

  // --- env ---
  env_run: {
    icon: PlayIcon,
    title: () => "env_run",
    argsSummary: (t) => t.input?.command || null,
    body: (t) => {
      const txt = getOutputText(t);
      // env_run returns JSON {code, stdout, stderr}
      try {
        const r = JSON.parse(txt);
        if (r && (typeof r.code === "number" || r.stdout != null || r.stderr != null)) {
          const combined = [r.stdout, r.stderr].filter(Boolean).join("\n");
          return <TerminalBlock command={t.input?.command} output={combined} errored={r.code !== 0} exitCode={r.code} />;
        }
      } catch {}
      return <TerminalBlock command={t.input?.command} output={txt} errored={t.status === "failed"} />;
    },
    inlineBody: true,
  },
};

// alias for repo_* to git_*
REGISTRY.repo_status = REGISTRY.git_status;
REGISTRY.repo_diff = REGISTRY.git_diff;
REGISTRY.repo_commit_all = REGISTRY.git_commit;
REGISTRY.repo_push = REGISTRY.git_push;

// Figma tools — generic JSON viewer with name in title
const figmaTitle = (t: ToolCall) => t.name.replace(/^figma_/, "figma ").replace(/_/g, " ");
const figmaSummary = (t: ToolCall) => {
  const fk = t.input?.fileKey;
  if (!fk) return null;
  const m = fk.match(/figma\.com\/(?:design|file)\/([^/?#]+)/);
  return m ? m[1] : (typeof fk === "string" ? fk.slice(0, 32) : null);
};
const figmaBody = (t: ToolCall) => {
  const txt = getOutputText(t);
  try {
    const data = JSON.parse(txt);
    return <JsonBlock data={data} max={6000} />;
  } catch {
    return <pre className="font-mono text-[11.5px] whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 px-3 py-2 max-h-80 overflow-auto scroll-thin">{txt}</pre>;
  }
};
for (const k of [
  "figma_get_file",
  "figma_find_nodes",
  "figma_get_node_subtree",
  "figma_get_components",
  "figma_get_styles",
  "figma_inspect_node",
  "figma_get_comments",
  "figma_get_images",
  "figma_search",
]) {
  REGISTRY[k] = {
    icon: Wrench,
    title: figmaTitle,
    argsSummary: figmaSummary,
    body: figmaBody,
    inlineBody: true,
  };
}

// figma_export_assets renders previews if any
REGISTRY.figma_export_assets = {
  icon: ImageIcon,
  title: () => "figma export_assets",
  argsSummary: (t) => Array.isArray(t.input?.nodeIds) ? `${t.input.nodeIds.length} nodes` : null,
  body: (t) => {
    if (t.outputImages?.length) return <ImageRenderer images={t.outputImages} caption="Exported assets" />;
    return figmaBody(t);
  },
  inlineBody: true,
  defaultOpen: true,
};

export function getToolRenderer(name: string): ToolRenderer {
  return REGISTRY[name] ?? {
    icon: Wrench,
    title: () => name,
    argsSummary: () => null,
  };
}
