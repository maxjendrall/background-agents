import { cn } from "@/lib/utils";

/**
 * Render a unified diff (output of `git diff`) with inline +/- coloring.
 * Recognizes:
 *   - "diff --git a/foo b/foo"   → file header
 *   - "@@ ... @@"                → hunk header
 *   - "+..." / "-..."            → added/removed lines
 *   - " ..."                     → context
 */

interface FileBlock {
  fileA?: string;
  fileB?: string;
  hunks: HunkBlock[];
  meta: string[]; // index, mode, etc
}

interface HunkBlock {
  header: string;
  lines: { kind: "ctx" | "add" | "del" | "meta"; text: string }[];
}

function parseUnifiedDiff(text: string): { stat?: string; files: FileBlock[] } {
  const out: FileBlock[] = [];
  let stat: string | undefined;
  // Split optional --stat block from actual diff
  const diffStart = text.search(/^diff --git /m);
  if (diffStart > 0) {
    stat = text.slice(0, diffStart).trim();
    text = text.slice(diffStart);
  } else if (diffStart < 0) {
    return { stat: text.trim() || undefined, files: [] };
  }
  const fileChunks = text.split(/^(?=diff --git )/m).filter(Boolean);
  for (const chunk of fileChunks) {
    const lines = chunk.split("\n");
    const file: FileBlock = { hunks: [], meta: [] };
    let cur: HunkBlock | null = null;
    for (const ln of lines) {
      if (ln.startsWith("diff --git ")) {
        const m = ln.match(/diff --git a\/(.+?) b\/(.+)$/);
        if (m) { file.fileA = m[1]; file.fileB = m[2]; }
      } else if (ln.startsWith("@@")) {
        if (cur) file.hunks.push(cur);
        cur = { header: ln, lines: [] };
      } else if (cur) {
        if (ln.startsWith("+") && !ln.startsWith("+++")) cur.lines.push({ kind: "add", text: ln.slice(1) });
        else if (ln.startsWith("-") && !ln.startsWith("---")) cur.lines.push({ kind: "del", text: ln.slice(1) });
        else if (ln.startsWith(" ")) cur.lines.push({ kind: "ctx", text: ln.slice(1) });
        else if (ln.length) cur.lines.push({ kind: "meta", text: ln });
      } else {
        if (ln.startsWith("---") || ln.startsWith("+++") || ln.startsWith("index ") || ln.startsWith("new file ") || ln.startsWith("deleted ") || ln.startsWith("rename ") || ln.startsWith("similarity ")) file.meta.push(ln);
      }
    }
    if (cur) file.hunks.push(cur);
    out.push(file);
  }
  return { stat, files: out };
}

export function DiffRenderer({ diff, className }: { diff: string; className?: string }) {
  const { stat, files } = parseUnifiedDiff(diff);
  if (!files.length && !stat) return null;
  return (
    <div className={cn("space-y-2", className)}>
      {stat && (
        <pre className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11.5px] leading-5 font-mono text-muted-foreground whitespace-pre overflow-x-auto scroll-thin">
          {stat}
        </pre>
      )}
      {files.map((f, i) => (
        <FileDiff key={i} file={f} />
      ))}
    </div>
  );
}

function FileDiff({ file }: { file: FileBlock }) {
  const name = file.fileB || file.fileA || "diff";
  const renamed = file.fileA && file.fileB && file.fileA !== file.fileB;
  const stats = countAddDel(file);
  return (
    <div className="rounded-lg border border-border bg-background/40 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 border-b border-border">
        <span className="text-[11px] font-mono font-semibold flex-1 truncate">
          {renamed ? `${file.fileA} → ${file.fileB}` : name}
        </span>
        <span className="text-[10.5px] tabular-nums">
          <span className="text-emerald-400">+{stats.add}</span>{" "}
          <span className="text-red-400">−{stats.del}</span>
        </span>
      </div>
      {file.hunks.map((h, i) => (
        <div key={i} className="border-t border-border/60 first:border-t-0">
          <div className="px-3 py-1 bg-primary/[0.04] text-primary/80 font-mono text-[11px] truncate">
            {h.header}
          </div>
          <div className="font-mono text-[11.5px] leading-[1.55]">
            {h.lines.map((l, j) => (
              <div
                key={j}
                className={cn(
                  "grid grid-cols-[20px_1fr] gap-0 px-0",
                  l.kind === "add" && "bg-emerald-500/10",
                  l.kind === "del" && "bg-red-500/10",
                  l.kind === "meta" && "italic text-muted-foreground bg-muted/20",
                )}
              >
                <span
                  className={cn(
                    "select-none text-center text-[11px] border-r border-border/40 bg-muted/20",
                    l.kind === "add" && "text-emerald-400 bg-emerald-500/15",
                    l.kind === "del" && "text-red-400 bg-red-500/15",
                  )}
                >
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                </span>
                <span className="px-2 whitespace-pre-wrap break-words">{l.text || " "}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function countAddDel(file: FileBlock) {
  let add = 0, del = 0;
  for (const h of file.hunks) for (const l of h.lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}

/**
 * Synthesize a diff from oldText/newText (used for the `edit` tool).
 * Uses a Myers-like LCS + a small context window.
 */
export function synthesizeEditDiff(opts: { path: string; oldText: string; newText: string }): string {
  const { path, oldText, newText } = opts;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const ops = diffLines(oldLines, newLines);
  // Build a single hunk surrounding all changes (Pi `edit` operates on small replacements)
  const ctx = 3;
  // Walk ops to find first change
  let firstChange = ops.findIndex((o) => o.kind !== "ctx");
  let lastChange = -1;
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i].kind !== "ctx") { lastChange = i; break; }
  if (firstChange < 0) return ""; // no change
  const start = Math.max(0, firstChange - ctx);
  const end = Math.min(ops.length, lastChange + 1 + ctx);
  const hunk = ops.slice(start, end);
  // Translate ops to old/new line numbers for header
  let oldStart = 1, newStart = 1;
  for (let i = 0; i < start; i++) {
    const o = ops[i];
    if (o.kind === "ctx") { oldStart++; newStart++; }
    else if (o.kind === "del") oldStart++;
    else if (o.kind === "add") newStart++;
  }
  let oldCount = 0, newCount = 0;
  for (const o of hunk) {
    if (o.kind === "ctx") { oldCount++; newCount++; }
    else if (o.kind === "del") oldCount++;
    else if (o.kind === "add") newCount++;
  }
  const lines: string[] = [];
  lines.push(`diff --git a/${path} b/${path}`);
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);
  lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
  for (const o of hunk) {
    if (o.kind === "ctx") lines.push(" " + o.text);
    else if (o.kind === "add") lines.push("+" + o.text);
    else if (o.kind === "del") lines.push("-" + o.text);
  }
  return lines.join("\n");
}

type DiffOp = { kind: "ctx" | "add" | "del"; text: string };

// Standard line-level LCS diff
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length;
  // Build LCS table (small inputs expected)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: "ctx", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: "del", text: a[i] }); i++; }
    else { ops.push({ kind: "add", text: b[j] }); j++; }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "add", text: b[j++] });
  return ops;
}
