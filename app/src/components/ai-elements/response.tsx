import * as React from "react";
import { marked } from "marked";
import { cn } from "@/lib/utils";

marked.setOptions({
  breaks: true,
  gfm: true,
});

export interface ResponseProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: string;
  streaming?: boolean;
}

export const Response = React.memo(({ className, children, streaming, ...props }: ResponseProps) => {
  const html = React.useMemo(() => {
    if (!children) return "";
    try {
      return marked.parse(children) as string;
    } catch {
      return escapeHtml(children).replace(/\n/g, "<br/>");
    }
  }, [children]);

  if (!children && !streaming) return null;
  return (
    <div
      className={cn("md-content", streaming && "streaming-caret", className)}
      dangerouslySetInnerHTML={{ __html: html || (streaming ? "" : "") }}
      {...props}
    />
  );
});
Response.displayName = "Response";

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
