import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ring-1 ring-inset",
  {
    variants: {
      variant: {
        default: "bg-primary/15 text-primary ring-primary/20",
        secondary: "bg-secondary text-secondary-foreground ring-border",
        outline: "bg-transparent text-foreground ring-border",
        success: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
        warn: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
        danger: "bg-red-500/15 text-red-300 ring-red-500/30",
        muted: "bg-muted text-muted-foreground ring-border",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
