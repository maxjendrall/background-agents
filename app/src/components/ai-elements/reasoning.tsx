import * as React from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface ReasoningProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean;
  isStreaming?: boolean;
}

export const Reasoning = ({ className, defaultOpen, isStreaming, children, ...props }: ReasoningProps) => {
  const [open, setOpen] = React.useState(Boolean(defaultOpen) || Boolean(isStreaming));
  React.useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "rounded-lg border border-border/60 bg-muted/30 overflow-hidden",
          isStreaming && "border-primary/30",
          className,
        )}
        {...props}
      >
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 transition-colors">
          <div className="flex items-center gap-2">
            <BrainIcon className={cn("size-3.5", isStreaming && "text-primary animate-pulse")} />
            <span className="font-medium">{isStreaming ? "Thinking…" : "Thoughts"}</span>
          </div>
          <ChevronDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent className="data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up overflow-hidden">
          <div className="px-3.5 pb-3 pt-1 text-[12.5px] leading-6 text-muted-foreground/90 font-mono whitespace-pre-wrap break-words border-t border-border/40">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};
