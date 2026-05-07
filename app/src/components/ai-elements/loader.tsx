import { cn } from "@/lib/utils";

export const Loader = ({ className }: { className?: string }) => (
  <span className={cn("inline-flex items-center gap-1 text-muted-foreground", className)}>
    <span className="pulse-dot" />
    <span className="pulse-dot" />
    <span className="pulse-dot" />
  </span>
);
