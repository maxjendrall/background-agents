import * as React from "react";
import { BotIcon, UserIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Role = "user" | "assistant" | "system";

export interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  from: Role;
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full gap-4 [&>div]:max-w-[100%] animate-slide-in-bottom",
      from === "user" ? "justify-end" : "justify-start",
      className,
    )}
    data-from={from}
    {...props}
  />
);

export interface MessageContentProps extends React.HTMLAttributes<HTMLDivElement> {
  from: Role;
}

export const MessageContent = ({ className, from, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex flex-col gap-2 overflow-hidden",
      from === "user"
        ? "rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-3 max-w-[68%] shadow-sm"
        : from === "system"
          ? "text-muted-foreground text-sm italic"
          : "w-full",
      className,
    )}
    {...props}
  />
);

export interface MessageAvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  from: Role;
}

export const MessageAvatar = ({ className, from, ...props }: MessageAvatarProps) => {
  if (from === "user") {
    return (
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground",
          "ring-1 ring-border",
          className,
        )}
        {...props}
      >
        <UserIcon className="size-4" />
      </div>
    );
  }
  if (from === "assistant") {
    return (
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          "bg-gradient-to-br from-primary/40 via-primary/20 to-fuchsia-500/30",
          "ring-1 ring-primary/30 text-primary-foreground",
          className,
        )}
        {...props}
      >
        <BotIcon className="size-4 text-primary" />
      </div>
    );
  }
  return null;
};
