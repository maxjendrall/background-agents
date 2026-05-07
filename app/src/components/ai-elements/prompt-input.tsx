import * as React from "react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface PromptInputProps extends React.FormHTMLAttributes<HTMLFormElement> {}

export const PromptInput = React.forwardRef<HTMLFormElement, PromptInputProps>(
  ({ className, ...props }, ref) => (
    <form
      ref={ref}
      className={cn(
        "relative flex flex-col rounded-2xl border border-border bg-card/80 backdrop-blur shadow-lg transition-shadow",
        "focus-within:border-primary/40 focus-within:shadow-xl",
        className,
      )}
      {...props}
    />
  ),
);
PromptInput.displayName = "PromptInput";

export interface PromptInputTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minRows?: number;
  maxRows?: number;
}

export const PromptInputTextarea = React.forwardRef<HTMLTextAreaElement, PromptInputTextareaProps>(
  ({ className, minRows = 1, maxRows = 12, onChange, ...props }, ref) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
    React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement);
    const resize = React.useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "0px";
      const lh = parseFloat(getComputedStyle(el).lineHeight || "20") || 20;
      const min = lh * minRows;
      const max = lh * maxRows;
      el.style.height = Math.max(min, Math.min(max, el.scrollHeight)) + "px";
    }, [minRows, maxRows]);
    React.useEffect(() => {
      resize();
    }, [resize, props.value]);
    return (
      <textarea
        ref={(el) => { innerRef.current = el; }}
        rows={minRows}
        onChange={(e) => {
          onChange?.(e);
          resize();
        }}
        className={cn(
          "w-full bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-6 outline-none resize-none",
          "placeholder:text-muted-foreground/70",
          className,
        )}
        {...props}
      />
    );
  },
);
PromptInputTextarea.displayName = "PromptInputTextarea";

export interface PromptInputToolbarProps extends React.HTMLAttributes<HTMLDivElement> {}
export const PromptInputToolbar = ({ className, ...props }: PromptInputToolbarProps) => (
  <div className={cn("flex items-center justify-between gap-2 px-2 py-2", className)} {...props} />
);

export const PromptInputTools = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-1", className)} {...props} />
);

export interface PromptInputSubmitProps extends React.ComponentProps<typeof Button> {
  status?: "idle" | "submitted" | "streaming" | "ready" | "error";
}

export const PromptInputSubmit = ({ status, className, children, ...props }: PromptInputSubmitProps) => {
  const isStreaming = status === "streaming" || status === "submitted";
  return (
    <Button
      type="submit"
      size="icon"
      className={cn(
        "size-9 rounded-full shadow-md disabled:opacity-50",
        "bg-primary text-primary-foreground hover:brightness-110",
        className,
      )}
      {...props}
    >
      {children ?? (isStreaming ? <SquareIcon className="size-3.5 fill-current" /> : <ArrowUpIcon className="size-4" />)}
    </Button>
  );
};
