const STREAM_CHUNK_TARGET = 4_000;

function cloneData(data) {
  if (data == null || typeof data !== "object") return data;
  return Array.isArray(data) ? data.map(cloneData) : { ...data };
}

function hasToolPayload(d) {
  return Boolean(d?.rawInput || d?.output || d?.content || d?.rawOutput);
}

function normalizeToolEvent(data, state) {
  if (!data || typeof data !== "object") return data;
  const d = cloneData(data);
  const id = d.id || d.toolCallId;

  if (d.type === "tool_start") {
    if (id && state.started.has(id)) return null;
    if (id) state.started.add(id);
    // Tool-start events often arrive while the model is still typing JSON args.
    // Keep the card/name, but wait for the execution-start update before showing input.
    if (d.status === "pending") delete d.input;
    return d;
  }

  if (d.type !== "tool_update") return d;

  // Pending tool updates are token-by-token partial JSON arguments. They are
  // invisible noise in the UI and can produce hundreds of events per tool call.
  if (d.status === "pending") return null;

  if (d.status === "in_progress") {
    // Drop partial execution output. Completed/failed events carry the final
    // result; keeping every intermediate stdout/tool-result frame makes logs
    // huge without changing the final rendered chat.
    if (d.output || d.content || d.rawOutput) return null;

    // Keep at most one stable execution-start input snapshot per distinct input.
    if (!d.rawInput) return null;
    const key = JSON.stringify(d.rawInput);
    if (id && state.inputKeys.get(id) === key) return null;
    if (id) state.inputKeys.set(id, key);
    return d;
  }

  // Completed/failed events carry the result and should be kept. Drop empty
  // duplicate terminal updates if AgentOS repeats them.
  if ((d.status === "completed" || d.status === "failed") && id) {
    const key = `${d.status}:${hasToolPayload(d) ? JSON.stringify(d).length : 0}`;
    if (state.terminalKeys.get(id) === key) return null;
    state.terminalKeys.set(id, key);
  }

  return d;
}

function makeState() {
  return {
    started: new Set(),
    inputKeys: new Map(),
    terminalKeys: new Map(),
  };
}

export function compactEvents(events, options = {}) {
  const maxStreamChars = options.maxStreamChars || STREAM_CHUNK_TARGET;
  const out = [];
  const toolState = makeState();
  let stream = null;

  const flushStream = () => {
    if (!stream || !stream.text) {
      stream = null;
      return;
    }
    out.push({
      ...stream.base,
      id: stream.lastId,
      ts: stream.lastTs,
      data: { ...(stream.base.data || {}), text: stream.text },
    });
    stream = null;
  };

  const pushStream = (evt) => {
    const text = String(evt.data?.text || "");
    if (!text) return;
    if (!stream || stream.type !== evt.type || stream.text.length >= maxStreamChars) flushStream();
    if (!stream) {
      stream = { type: evt.type, base: evt, text: "", lastId: evt.id, lastTs: evt.ts };
    }
    stream.text += text;
    stream.lastId = evt.id;
    stream.lastTs = evt.ts;
    if (stream.text.length >= maxStreamChars) flushStream();
  };

  for (const evt of events || []) {
    if (!evt || typeof evt !== "object") continue;
    if ((evt.type === "agent.text" || evt.type === "agent.thinking") && typeof evt.data?.text === "string") {
      pushStream(evt);
      continue;
    }

    flushStream();

    if (evt.type === "agent.tool_acp") {
      const data = normalizeToolEvent(evt.data, toolState);
      if (data) out.push({ ...evt, data });
      continue;
    }

    out.push(evt);
  }

  flushStream();
  return out;
}

export function compactEventsAfter(events, afterId, options = {}) {
  if (!afterId) return compactEvents(events, options);
  const idx = (events || []).findIndex((e) => e?.id === afterId);
  if (idx < 0) return compactEvents(events, options);
  return compactEvents(events.slice(idx + 1), options);
}

export function normalizeLiveEvent(type, data, state = makeState()) {
  if (type !== "agent.tool_acp") return { type, data };
  const next = normalizeToolEvent(data, state);
  return next ? { type, data: next } : null;
}

export function createLiveEventState() {
  return makeState();
}
