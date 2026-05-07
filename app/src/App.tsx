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

/**
 * Compare two values for "presentation equality" — i.e. would the rendered UI differ?
 * Returns true if they are equal and we can skip the setState.
 */
function shallowEqualHealth(a: Health | null, b: Health | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.ok !== b.ok) return false;
  if (a.model !== b.model) return false;
  if (a.queue !== b.queue) return false;
  if (a.active !== b.active) return false;
  if (a.jobs !== b.jobs) return false;
  if (a.workspace !== b.workspace) return false;
  if (a.thinkingLevel !== b.thinkingLevel) return false;
  const ax = a.extensions || [];
  const bx = b.extensions || [];
  if (ax.length !== bx.length) return false;
  for (let i = 0; i < ax.length; i++) if (ax[i].id !== bx[i].id) return false;
  return true;
}

function jobsEqual(a: Job[], b: Job[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (
      x.id !== y.id ||
      x.status !== y.status ||
      x.title !== y.title ||
      x.issueKey !== y.issueKey ||
      x.model !== y.model ||
      x.completedAt !== y.completedAt ||
      x.createdAt !== y.createdAt ||
      x.error !== y.error ||
      x.hasSession !== y.hasSession
    ) {
      return false;
    }
  }
  return true;
}

export default function App() {
  const [view, setView] = React.useState<View>(readUrl());
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [health, setHealth] = React.useState<Health | null>(null);

  const jobsRef = React.useRef(jobs);
  jobsRef.current = jobs;
  const healthRef = React.useRef(health);
  healthRef.current = health;

  const refreshJobs = React.useCallback(async () => {
    try {
      const r = await api.jobs();
      // Only update if something actually changed — prevents the 5s polling flicker.
      if (!jobsEqual(jobsRef.current, r.jobs)) setJobs(r.jobs);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const refreshHealth = React.useCallback(async () => {
    try {
      const next = await api.health();
      if (!shallowEqualHealth(healthRef.current, next)) setHealth(next);
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

  // Stable callbacks so memoized children don't re-render due to new function refs.
  const handleSelect = React.useCallback(
    (id: string) => navigate({ kind: "chat", jobId: id }),
    [navigate],
  );
  const handleNew = React.useCallback(() => navigate({ kind: "new" }), [navigate]);
  const handleCreated = React.useCallback(
    (id: string) => {
      refreshJobs();
      navigate({ kind: "chat", jobId: id });
    },
    [navigate, refreshJobs],
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-full app-bg">
        <Sidebar
          jobs={jobs}
          activeJobId={view.kind === "chat" ? view.jobId : null}
          health={health}
          onSelect={handleSelect}
          onNew={handleNew}
          onRefresh={refreshJobs}
        />
        <main className="flex-1 flex flex-col min-w-0 h-full">
          {view.kind === "new" ? (
            <NewChatPanel health={health} onCreated={handleCreated} />
          ) : (
            <ChatView jobId={view.jobId} health={health} />
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
