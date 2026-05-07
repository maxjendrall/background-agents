import * as React from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatView, NewChatPanel } from "@/components/ChatView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { Health, Job } from "@/lib/types";

type View = { kind: "new" } | { kind: "chat"; jobId: string };

function readUrl(): View {
  const m = (location.hash || "").match(/^#chat\/(.+)$/);
  if (m) return { kind: "chat", jobId: m[1] };
  return { kind: "new" };
}
function writeUrl(v: View) {
  const next = v.kind === "chat" ? `#chat/${v.jobId}` : "";
  if (location.hash !== next) history.pushState({}, "", `/app/${next}`);
}

export default function App() {
  const [view, setView] = React.useState<View>(readUrl());
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [health, setHealth] = React.useState<Health | null>(null);

  const refreshJobs = React.useCallback(async () => {
    try {
      const r = await api.jobs();
      setJobs(r.jobs);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const refreshHealth = React.useCallback(async () => {
    try {
      setHealth(await api.health());
    } catch (e) {
      console.error(e);
    }
  }, []);

  React.useEffect(() => {
    refreshJobs();
    refreshHealth();
    const id = setInterval(() => {
      refreshJobs();
      refreshHealth();
    }, 5000);
    return () => clearInterval(id);
  }, [refreshHealth, refreshJobs]);

  React.useEffect(() => {
    const onPop = () => setView(readUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = React.useCallback((v: View) => {
    setView(v);
    writeUrl(v);
  }, []);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-full app-bg">
        <Sidebar
          jobs={jobs}
          activeJobId={view.kind === "chat" ? view.jobId : null}
          health={health}
          onSelect={(id) => navigate({ kind: "chat", jobId: id })}
          onNew={() => navigate({ kind: "new" })}
          onRefresh={refreshJobs}
        />
        <main className="flex-1 flex flex-col min-w-0 h-full">
          {view.kind === "new" ? (
            <NewChatPanel
              health={health}
              onCreated={(id) => {
                refreshJobs();
                navigate({ kind: "chat", jobId: id });
              }}
            />
          ) : (
            <ChatView jobId={view.jobId} health={health} />
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
