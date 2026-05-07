import { GitCommitIcon, GitBranchIcon, FileEditIcon, FilePlusIcon, FileMinusIcon, FileQuestionIcon, ExternalLinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DiffRenderer } from "./diff";

interface GitStatusFile {
  status: string; // "M", "A", "D", "??", "R" etc
  path: string;
}

interface GitStatusBlock {
  branchInfo?: string;
  ahead?: number;
  behind?: number;
  files: GitStatusFile[];
  rawHeader?: string;
}

/**
 * Output of `git status --short --branch`:
 *   ## branch...origin/branch
 *    M src/foo.ts
 *   ?? src/new.ts
 *
 * The git extension prefixes with "<repoPath>:\n<status>".
 */
export function GitStatusRenderer({ output }: { output: string }) {
  const blocks = parseGitStatus(output);
  if (!blocks.length) return null;
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => (
        <div key={i} className="rounded-lg border border-border bg-card/30 overflow-hidden">
          {b.rawHeader && (
            <div className="px-3 py-1.5 bg-muted/40 border-b border-border flex items-center gap-2">
              <GitBranchIcon className="size-3.5 text-primary" />
              <span className="font-mono text-[11.5px] truncate flex-1">{b.rawHeader}</span>
              {b.branchInfo && (
                <span className="text-[10.5px] text-muted-foreground font-mono">
                  {b.branchInfo}
                  {b.ahead ? <span className="text-emerald-400 ml-1">↑{b.ahead}</span> : null}
                  {b.behind ? <span className="text-amber-400 ml-1">↓{b.behind}</span> : null}
                </span>
              )}
            </div>
          )}
          {b.files.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-muted-foreground italic">Clean</div>
          ) : (
            <ul className="divide-y divide-border/40">
              {b.files.map((f, j) => (
                <li key={j} className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent/20">
                  <StatusGlyph code={f.status} />
                  <span className="font-mono text-[11.5px] truncate">{f.path}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function StatusGlyph({ code }: { code: string }) {
  // Two-char codes: " M", "M ", "MM", "??", "A ", "D ", "R ", etc.
  const c = code.trim();
  if (c === "??") return <FileQuestionIcon className="size-3.5 text-amber-400 shrink-0" />;
  if (c.includes("A")) return <FilePlusIcon className="size-3.5 text-emerald-400 shrink-0" />;
  if (c.includes("D")) return <FileMinusIcon className="size-3.5 text-red-400 shrink-0" />;
  if (c.includes("R")) return <FileEditIcon className="size-3.5 text-blue-400 shrink-0" />;
  return <FileEditIcon className="size-3.5 text-amber-400 shrink-0" />;
}

function parseGitStatus(output: string): GitStatusBlock[] {
  // Split into per-repo blocks. Format: "<path>:\n<status>"
  const blocks: GitStatusBlock[] = [];
  const sections = output.split(/\n\s*\n/).filter(Boolean);
  for (const section of sections) {
    const lines = section.split("\n");
    if (!lines.length) continue;
    const block: GitStatusBlock = { files: [] };
    let startIdx = 0;
    // first line might be "<path>: error: ..." or just status
    if (lines[0].endsWith(":")) {
      block.rawHeader = lines[0].slice(0, -1);
      startIdx = 1;
    } else if (/^\S+:.+/.test(lines[0]) && !lines[0].startsWith("##") && !/^[A-Z?!]\s/.test(lines[0])) {
      // "/path: error: ..." style
      const colon = lines[0].indexOf(":");
      block.rawHeader = lines[0].slice(0, colon);
      lines[0] = lines[0].slice(colon + 1).trim();
    }
    for (let i = startIdx; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln) continue;
      if (ln.startsWith("##")) {
        const m = ln.slice(2).trim();
        block.branchInfo = m;
        const ah = m.match(/ahead\s+(\d+)/);
        const be = m.match(/behind\s+(\d+)/);
        if (ah) block.ahead = Number(ah[1]);
        if (be) block.behind = Number(be[1]);
      } else if (ln.toLowerCase().startsWith("error:")) {
        block.files.push({ status: "!!", path: ln });
      } else {
        // "?? path" or " M path" or "MM path"
        const m = ln.match(/^(..|.|\?\?)\s+(.+)$/);
        if (m) block.files.push({ status: m[1], path: m[2] });
      }
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * git_diff output: "<stat>\n\ndiff --git ..."
 */
export function GitDiffRenderer({ output }: { output: string }) {
  const trimmed = output.trim();
  if (!trimmed || trimmed === "No changes") {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground italic">
        No changes
      </div>
    );
  }
  return <DiffRenderer diff={output} />;
}

/**
 * git_log: "<short>  <subject>" lines
 */
export function GitLogRenderer({ output }: { output: string }) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = lines
    .map((l) => l.match(/^([0-9a-f]{7,40})\s+(.*)$/))
    .filter(Boolean) as RegExpMatchArray[];
  if (!items.length) {
    return <pre className="font-mono text-[11.5px] whitespace-pre-wrap">{output}</pre>;
  }
  return (
    <ul className="rounded-lg border border-border bg-card/30 overflow-hidden divide-y divide-border/40 font-mono text-[12px]">
      {items.map((m, i) => (
        <li key={i} className="flex items-center gap-3 px-3 py-1.5 hover:bg-accent/20">
          <span className="text-primary text-[11.5px]">{m[1].slice(0, 7)}</span>
          <span className="flex-1 truncate text-foreground/90">{m[2]}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * git_commit output: "[branch hash] message\n N files changed, ..."
 */
export function GitCommitRenderer({ output }: { output: string }) {
  if (output.trim() === "Nothing to commit") {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground italic">
        Nothing to commit
      </div>
    );
  }
  const head = output.split("\n").find((l) => l.match(/^\[.+?\s+([0-9a-f]+)\]/));
  const hashMatch = head?.match(/\[(.+?)\s+([0-9a-f]+)\]\s+(.*)/);
  const restLines = output.split("\n").slice(head ? 1 : 0).filter(Boolean);
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20">
        <GitCommitIcon className="size-3.5 text-emerald-400" />
        {hashMatch ? (
          <>
            <span className="text-[10.5px] font-mono text-muted-foreground">
              <span className="text-primary">{hashMatch[1]}</span>
              <span className="mx-1">·</span>
              <span>{hashMatch[2]}</span>
            </span>
            <span className="text-[12.5px] truncate">{hashMatch[3]}</span>
          </>
        ) : (
          <span className="text-[12.5px]">{output.split("\n")[0]}</span>
        )}
      </div>
      {restLines.length > 0 && (
        <div className="px-3 py-1.5 text-[11.5px] font-mono text-muted-foreground">
          {restLines.join("\n")}
        </div>
      )}
    </div>
  );
}

/**
 * git_push output: "Pushed <branch>\n<git output>"
 */
export function GitPushRenderer({ output }: { output: string }) {
  if (output.startsWith("Error:")) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 text-[12px] font-mono whitespace-pre-wrap">
        {output}
      </div>
    );
  }
  const m = output.match(/^Pushed\s+(\S+)/);
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20">
        <GitBranchIcon className="size-3.5 text-emerald-400" />
        <span className="text-[12.5px] font-medium">Pushed</span>
        {m && <span className="font-mono text-[12px]">{m[1]}</span>}
      </div>
      <pre className="px-3 py-1.5 text-[11.5px] font-mono whitespace-pre-wrap text-muted-foreground">
        {output}
      </pre>
    </div>
  );
}

/**
 * gh_pr_create result: usually a URL or JSON
 */
export function GitHubPRRenderer({ output }: { output: string }) {
  const url = output.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/)?.[0];
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3.5 py-2 hover:bg-primary/10 transition-colors"
      >
        <span className="size-7 rounded-full bg-primary/15 flex items-center justify-center text-primary">
          <GitCommitIcon className="size-3.5" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[10.5px] uppercase tracking-wide text-muted-foreground">Pull request opened</span>
          <span className="block text-[12.5px] font-mono text-primary truncate">{url}</span>
        </span>
        <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
      </a>
    );
  }
  return (
    <pre className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11.5px] font-mono whitespace-pre-wrap break-words">
      {output}
    </pre>
  );
}
