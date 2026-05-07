import * as React from "react";
import { cn } from "@/lib/utils";
// @ts-expect-error - no types for ansi-to-react
import Ansi from "ansi-to-react";
import {
  TerminalIcon,
  FileTextIcon,
  FolderTreeIcon,
  SearchIcon,
} from "lucide-react";

const MAX_INLINE = 12_000;

function truncate(text: string, max = MAX_INLINE) {
  if (!text) return { text: "", overflow: 0 };
  if (text.length <= max) return { text, overflow: 0 };
  return { text: text.slice(0, max), overflow: text.length - max };
}

export function TerminalBlock({
  command,
  output,
  errored,
  exitCode,
}: {
  command?: string;
  output: string;
  errored?: boolean;
  exitCode?: number | null;
}) {
  const t = truncate(output);
  return (
    <div className={cn(
      "rounded-lg border overflow-hidden font-mono text-[12px] leading-[1.55]",
      errored ? "border-destructive/40" : "border-border",
    )}>
      {command && (
        <div className={cn(
          "flex items-center gap-2 px-3 py-1.5 border-b text-foreground/90",
          errored ? "border-destructive/30 bg-destructive/10" : "border-border bg-muted/40",
        )}>
          <TerminalIcon className={cn("size-3.5 shrink-0", errored ? "text-destructive" : "text-primary")} />
          <span className={cn("opacity-70 select-none", errored ? "text-destructive" : "text-primary")}>
            {errored ? "✗" : "$"}
          </span>
          <code className="flex-1 truncate">{command}</code>
          {typeof exitCode === "number" && exitCode !== 0 && (
            <span className="text-[10.5px] text-destructive">exit {exitCode}</span>
          )}
        </div>
      )}
      <pre className="px-3 py-2 whitespace-pre-wrap break-words text-foreground/85 max-h-[420px] overflow-auto scroll-thin bg-background/40">
        <Ansi useClasses={false}>{t.text}</Ansi>
        {t.overflow > 0 && (
          <span className="text-muted-foreground italic">{`\n…(${t.overflow.toLocaleString()} more chars)`}</span>
        )}
      </pre>
    </div>
  );
}

export function FileViewer({
  path,
  content,
  language,
}: {
  path?: string;
  content: string;
  language?: string;
}) {
  const t = truncate(content);
  const lines = t.text.split("\n");
  const lineNumWidth = String(lines.length).length;
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {path && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 border-b border-border">
          <FileTextIcon className="size-3.5 text-muted-foreground" />
          <span className="text-[11.5px] font-mono truncate flex-1">{path}</span>
          {language && <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{language}</span>}
        </div>
      )}
      <div className="font-mono text-[11.5px] leading-[1.55] max-h-[420px] overflow-auto scroll-thin bg-background/30">
        {lines.map((ln, i) => (
          <div key={i} className="grid" style={{ gridTemplateColumns: `${lineNumWidth + 1.5}ch 1fr` }}>
            <span className="text-right pr-2 text-muted-foreground/50 select-none border-r border-border/40 bg-muted/20">
              {i + 1}
            </span>
            <span className="pl-3 whitespace-pre-wrap break-all">{ln || " "}</span>
          </div>
        ))}
        {t.overflow > 0 && (
          <div className="px-3 py-1 italic text-muted-foreground bg-muted/30 border-t border-border/40">
            …({t.overflow.toLocaleString()} more chars)
          </div>
        )}
      </div>
    </div>
  );
}

export function FileList({
  paths,
  icon = "tree",
}: {
  paths: string[];
  icon?: "tree" | "search";
}) {
  const Icon = icon === "search" ? SearchIcon : FolderTreeIcon;
  return (
    <div className="rounded-lg border border-border bg-card/30 overflow-hidden">
      <div className="px-3 py-1.5 bg-muted/40 border-b border-border text-[10.5px] uppercase tracking-wide text-muted-foreground font-medium inline-flex items-center gap-1.5">
        <Icon className="size-3" /> {paths.length} result{paths.length === 1 ? "" : "s"}
      </div>
      <ul className="divide-y divide-border/40 font-mono text-[11.5px] max-h-72 overflow-auto scroll-thin">
        {paths.slice(0, 200).map((p, i) => (
          <li key={i} className="px-3 py-1 hover:bg-accent/20 transition-colors truncate">{p}</li>
        ))}
        {paths.length > 200 && (
          <li className="px-3 py-1 italic text-muted-foreground">…({paths.length - 200} more)</li>
        )}
      </ul>
    </div>
  );
}

export function StatusOnly({ text, tone }: { text: string; tone?: "success" | "warn" | "error" }) {
  return (
    <div className={cn(
      "rounded-md px-3 py-2 text-[12.5px] inline-flex items-center gap-2 ring-1 ring-inset",
      tone === "error" && "bg-destructive/10 text-destructive ring-destructive/30",
      tone === "warn" && "bg-amber-500/10 text-amber-300 ring-amber-500/30",
      (!tone || tone === "success") && "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
    )}>
      {text}
    </div>
  );
}

export function KeyValueGrid({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="rounded-lg border border-border bg-card/30 overflow-hidden">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 text-[12px]">
        {items.map((it, i) => (
          <React.Fragment key={i}>
            <dt className={cn("py-1.5 px-3 text-muted-foreground border-b border-border/40", i === items.length - 1 && "border-b-0")}>
              {it.label}
            </dt>
            <dd className={cn("py-1.5 px-3 font-mono break-all border-b border-border/40", i === items.length - 1 && "border-b-0")}>
              {it.value}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

export function JsonBlock({ data, max = 4000 }: { data: any; max?: number }) {
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const t = truncate(json, max);
  return (
    <pre className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11.5px] leading-5 font-mono whitespace-pre-wrap break-words text-foreground/85 max-h-72 overflow-auto scroll-thin">
      {t.text}
      {t.overflow > 0 && (
        <span className="text-muted-foreground italic">{`\n…(${t.overflow.toLocaleString()} more chars)`}</span>
      )}
    </pre>
  );
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  py: "py", rb: "rb", go: "go", rs: "rs", java: "java", kt: "kt",
  ex: "ex", exs: "ex", erl: "erl", elm: "elm",
  html: "html", css: "css", scss: "scss", json: "json", yaml: "yaml", yml: "yaml",
  md: "md", sh: "sh", sql: "sql", graphql: "graphql", gql: "graphql",
};

export function inferLanguage(path?: string): string | undefined {
  if (!path) return;
  const m = path.match(/\.([a-z0-9]+)$/i);
  if (!m) return;
  return EXT_TO_LANG[m[1].toLowerCase()];
}
