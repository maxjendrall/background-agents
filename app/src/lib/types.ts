export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "idle"
  | "unknown";

export interface Job {
  id: string;
  kind: string;
  title: string;
  issueKey?: string | null;
  status: JobStatus;
  model?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  result?: string | null;
  error?: string | null;
  hasSession?: boolean;
}

export interface AgentEvent {
  id: string;
  jobId: string;
  type: string;
  ts: string;
  data?: Record<string, any>;
}

export interface Health {
  ok: boolean;
  workspace?: string | null;
  model?: string;
  concurrency?: number;
  queue?: number;
  active?: number;
  jobs?: number;
  extensions?: { id: string }[];
}

export type ToolStatus = "pending" | "running" | "in_progress" | "completed" | "failed";

export interface ToolImage {
  mimeType: string;
  data: string; // base64
}

export interface ToolCall {
  id: string;
  name: string;
  status: ToolStatus;
  input?: any;
  args?: any;
  outputText?: string;
  outputImages?: ToolImage[];
  outputDetails?: any;
  result?: string;
  ts?: string;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatPart {
  kind: "text" | "tool" | "thinking" | "system";
  // text:
  text?: string;
  // tool:
  tool?: ToolCall;
  // thinking:
  thinking?: string;
  // system message (clone, reset, etc):
  system?: { label: string; detail?: string; tone?: "info" | "warn" | "error" };
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  parts: ChatPart[];
  ts: string;
  status?: "streaming" | "done";
}
