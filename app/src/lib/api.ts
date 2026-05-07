import type { AgentEvent, Health, Job } from "./types";

const TOKEN_KEY = "bg-agents-token";
export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${t || res.statusText}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () => call<Health>("/health"),
  config: () => call<{ model: string; concurrency: number; workspace: string | null; extensions: { id: string }[] }>("/api/config"),
  setModel: (model: string) => call<{ model: string }>("/api/config/model", { method: "PUT", body: JSON.stringify({ model }) }),
  jobs: () => call<{ jobs: Job[] }>("/api/jobs"),
  job: (id: string, withEvents = false) =>
    call<{ job: Job & { events?: AgentEvent[] } }>(`/api/jobs/${id}${withEvents ? "?events=1" : ""}`),
  run: (body: { prompt: string; issueKey?: string; model?: string; title?: string }) =>
    call<{ job: Job }>(body.issueKey ? "/api/jira/trigger" : "/api/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  prompt: (id: string, prompt: string) =>
    call<{ job: Job }>(`/api/jobs/${id}/prompt`, { method: "POST", body: JSON.stringify({ prompt }) }),
  cancel: (id: string) => call<{ job: Job }>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  reset: (id: string) => call<{ job: Job; reset: boolean }>(`/api/jobs/${id}/reset`, { method: "POST" }),
};

export function streamEvents(
  jobId: string,
  onEvent: (e: AgentEvent) => void,
  onError?: (e: Event) => void,
  opts: { afterId?: string } = {},
): () => void {
  const t = getToken();
  const params = new URLSearchParams();
  if (t) params.set("token", t);
  if (opts.afterId) params.set("after", opts.afterId);
  const qs = params.toString();
  const url = `/api/jobs/${jobId}/events${qs ? `?${qs}` : ""}`;
  const es = new EventSource(url);
  const handler = (msg: MessageEvent) => {
    try {
      const e = JSON.parse(msg.data) as AgentEvent;
      onEvent(e);
    } catch {
      /* ignore */
    }
  };
  es.onmessage = handler;
  for (const n of [
    "job.created",
    "job.started",
    "job.completed",
    "job.failed",
    "job.cancelled",
    "job.updated",
    "queue.enqueued",
    "agent.text",
    "agent.thinking",
    "agent.tool",
    "agent.tool_exec",
    "agent.tool_acp",
    "agent.session_created",
    "agent.follow_up",
    "job.cloning",
    "job.cloned",
    "job.cloning_repos",
    "job.repos_ready",
    "job.clone_failed",
    "follow_up.queued",
    "session.reset",
    "jira.commented",
  ]) {
    es.addEventListener(n, handler as EventListener);
  }
  if (onError) es.onerror = onError;
  return () => es.close();
}
