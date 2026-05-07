import * as React from "react";
import { ExpandIcon, ImageIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolImage } from "@/lib/types";

export function ImageRenderer({
  images,
  caption,
  className,
}: {
  images?: ToolImage[];
  caption?: string;
  className?: string;
}) {
  const [zoom, setZoom] = React.useState<string | null>(null);
  if (!images?.length) return null;
  return (
    <div className={cn("space-y-2", className)}>
      {caption && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <ImageIcon className="size-3.5" />
          <span className="truncate">{caption}</span>
        </div>
      )}
      <div className={cn("grid gap-2", images.length === 1 ? "grid-cols-1" : "grid-cols-2 sm:grid-cols-3")}>
        {images.map((img, i) => {
          const url = `data:${img.mimeType};base64,${img.data}`;
          return (
            <button
              key={i}
              type="button"
              onClick={() => setZoom(url)}
              className="group relative rounded-lg border border-border bg-card/40 overflow-hidden hover:border-primary/40 transition-colors"
            >
              <img
                src={url}
                alt={caption || `image ${i + 1}`}
                className="block w-full max-h-[420px] object-contain bg-checker"
                style={{ backgroundImage: "linear-gradient(45deg,hsl(var(--muted)) 25%,transparent 25%),linear-gradient(-45deg,hsl(var(--muted)) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,hsl(var(--muted)) 75%),linear-gradient(-45deg,transparent 75%,hsl(var(--muted)) 75%)", backgroundSize: "16px 16px", backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0" }}
              />
              <div className="absolute top-1.5 right-1.5 size-7 rounded-md bg-background/70 backdrop-blur ring-1 ring-border opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-foreground">
                <ExpandIcon className="size-3.5" />
              </div>
            </button>
          );
        })}
      </div>
      {zoom && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-6 cursor-zoom-out animate-fade-in"
          onClick={() => setZoom(null)}
        >
          <img src={zoom} alt="zoom" className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
          <button
            type="button"
            onClick={() => setZoom(null)}
            className="absolute top-4 right-4 size-9 rounded-full bg-background/80 ring-1 ring-border flex items-center justify-center text-foreground hover:bg-background"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
