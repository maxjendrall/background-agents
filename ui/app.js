const $ = (sel) => document.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") { for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); }
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) { if (c != null) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
  return el;
};

// --- ANSI to HTML ---
function ansiToHtml(text) {
  if (!text) return "";
  const colors = { 30:"#666",31:"#f85149",32:"#3fb950",33:"#d29922",34:"#58a6ff",35:"#bc8cff",36:"#39c5cf",37:"#c9d1d9",90:"#666",91:"#ff7b72",92:"#56d364",93:"#e3b341",94:"#79c0ff",95:"#d2a8ff",96:"#56d4dd",97:"#ffffff" };
  let out = "", style = "";
  const parts = text.split(/(\x1b\[[0-9;]*m)/g);
  for (const p of parts) {
    const m = p.match(/^\x1b\[([0-9;]*)m$/);
    if (m) {
      const codes = m[1].split(";").map(Number);
      for (const c of codes) {
        if (c === 0 || c === "") { style = ""; }
        else if (c === 1) { style += "font-weight:bold;"; }
        else if (c === 2) { style += "opacity:0.6;"; }
        else if (c === 3) { style += "font-style:italic;"; }
        else if (colors[c]) { style += "color:" + colors[c] + ";"; }
      }
    } else if (p) {
      const escaped = p.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      out += style ? `<span style="${style}">${escaped}</span>` : escaped;
    }
  }
  return out;
}

const TOKEN = localStorage.getItem("bg-agents-token") || "";
const hdrs = () => TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...hdrs(), ...opts.headers } });
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  return res.json();
}

let state = { view: "list", jobs: [], health: null, jobId: null, job: null, events: [], chat: "", thinking: "", tools: [] };
let eventSource = null;
let formState = { prompt: "", issueKey: "", model: "", thinkingLevel: "" };
let followUpText = "";
let followUpModel = "";
let followUpThinkingLevel = "";
let followUpMessageMode = "follow_up";

// --- URL ---
function pushUrl(v, id) { history.pushState({}, "", v === "detail" && id ? `/ui#job/${id}` : "/ui"); }
function readUrl() { const m = (location.hash || "").match(/^#job\/(.+)$/); return m ? { view: "detail", jobId: m[1] } : { view: "list" }; }
window.addEventListener("popstate", () => { const r = readUrl(); r.jobId ? selectJob(r.jobId, true) : backToList(); });
function backToList() { state.view = "list"; closeEs(); pushUrl("list"); render(); }
function closeEs() { if (eventSource) { eventSource.close(); eventSource = null; } }

// --- Data ---
async function fetchHealth() { try { state.health = await api("/health"); } catch {} }
async function fetchJobs() { try { state.jobs = (await api("/api/jobs")).jobs || []; } catch {} }

function rebuildFromEvents() {
  let chat = "", thinking = "";
  const tools = [];
  for (const e of state.events) {
    if (e.type === "agent.text") chat += e.data?.text || "";
    if (e.type === "agent.thinking") thinking += e.data?.text || "";
    if (e.type === "follow_up.queued") chat += "\n\n---\nFollow-up: " + (e.data?.prompt || "") + "\n---\n\n";
    if (e.type === "agent.tool_acp") {
      const d = e.data;
      if (d.type === "tool_start") tools.push({ id: d.id, name: d.name || "tool", status: d.status || "pending", input: d.input, ts: e.ts });
      if (d.type === "tool_update") {
        const t = tools.find((x) => x.id === d.id);
        if (t) {
          if (d.status && d.status !== "pending") t.status = d.status;
          // Extract output text from the ACP content structure (last update wins, not accumulated)
          if (d.output?.content) {
            const texts = d.output.content.filter(c => c.type === "text").map(c => c.text);
            if (texts.length) t.outputText = texts.join("");
          }
          if (d.content) {
            const texts = d.content.filter(c => c.type === "content" && c.content?.text).map(c => c.content.text);
            if (texts.length) t.outputText = texts.join("");
          }
          if (d.rawInput && Object.keys(d.rawInput).length) t.input = d.rawInput;
        }
      }
    }
    if (e.type === "agent.tool") {
      const d = e.data;
      if (d.phase === "start") tools.push({ id: d.id || `t${tools.length}`, name: d.name || "tool", status: "running", ts: e.ts });
      if (d.phase === "end") { const t = [...tools].reverse().find((x) => x.name === d.name && x.status !== "completed"); if (t) t.status = "completed"; }
    }
    if (e.type === "agent.tool_exec") {
      const d = e.data;
      if (d.phase === "start") tools.push({ id: `${d.tool}_${tools.length}`, name: d.tool, status: "running", args: d.args, ts: e.ts });
      if (d.phase === "end") { const t = [...tools].reverse().find((x) => x.name === d.tool && x.status === "running"); if (t) { t.status = d.isError ? "failed" : "completed"; t.result = d.result; } }
    }
  }
  state.chat = chat; state.thinking = thinking; state.tools = tools;
}

async function selectJob(id, skipPush) {
  state.view = "detail"; state.jobId = id; followUpText = "";
  if (!skipPush) pushUrl("detail", id);
  try { const r = await api(`/api/jobs/${id}?events=1`); state.job = r.job; state.events = r.job?.events || []; }
  catch { state.job = { id, status: "unknown", title: id }; state.events = []; }
  rebuildFromEvents(); render();
  closeEs();
  const es = new EventSource(`/api/jobs/${id}/events${TOKEN ? "?token=" + encodeURIComponent(TOKEN) : ""}`);
  eventSource = es;
  const handler = (msg) => {
    let e; try { e = JSON.parse(msg.data); } catch { return; }
    if (e.id && state.events.some((x) => x.id === e.id)) return;
    state.events.push(e);
    if (e.type === "agent.text") { state.chat += e.data?.text || ""; const el = $("#chat-output"); if (el) el.textContent = state.chat; }
    if (e.type === "agent.thinking") { state.thinking += e.data?.text || ""; const el = $("#thinking-content"); if (el) { el.textContent = state.thinking; el.scrollTop = el.scrollHeight; } }
    if (e.type === "agent.tool_acp" || e.type === "agent.tool" || e.type === "agent.tool_exec") { rebuildFromEvents(); renderTimeline(); }
    if (e.type === "follow_up.queued") { rebuildFromEvents(); const el = $("#chat-output"); if (el) el.textContent = state.chat; }
    if (e.type === "job.completed" || e.type === "job.failed") { api(`/api/jobs/${state.jobId}`).then((r) => { state.job = r.job; renderJobStatus(); }); }
  };
  es.onmessage = handler;
  for (const n of ["job.created","job.started","job.completed","job.failed","job.cancelled","queue.enqueued","agent.text","agent.thinking","agent.tool","agent.tool_exec","agent.tool_acp","agent.session_created","job.cloning","job.cloned","follow_up.queued","agent.follow_up"]) es.addEventListener(n, handler);
}

async function triggerRun() {
  const prompt = formState.prompt.trim();
  if (!prompt) return;
  const body = { prompt };
  if (formState.issueKey.trim()) body.issueKey = formState.issueKey.trim();
  if (formState.model.trim()) body.model = formState.model.trim();
  if (formState.thinkingLevel.trim()) body.thinkingLevel = formState.thinkingLevel.trim();
  const endpoint = body.issueKey ? "/api/jira/trigger" : "/api/run";
  const res = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
  formState.prompt = ""; formState.issueKey = ""; formState.thinkingLevel = "";
  if (res.job?.id) selectJob(res.job.id); else { await fetchJobs(); render(); }
}

async function sendFollowUp() {
  const text = followUpText.trim();
  if (!text || !state.jobId) return;
  followUpText = "";
  const input = $("#follow-up-input"); if (input) input.value = "";
  const body = { prompt: text };
  if (followUpModel.trim()) body.model = followUpModel.trim();
  if (followUpThinkingLevel.trim()) body.thinkingLevel = followUpThinkingLevel.trim();
  body.messageMode = followUpMessageMode || "follow_up";
  await api(`/api/jobs/${state.jobId}/prompt`, { method: "POST", body: JSON.stringify(body) });
}

async function switchModel(model, thinkingLevel) {
  const body = {};
  if (model) body.model = model;
  if (thinkingLevel) body.thinkingLevel = thinkingLevel;
  await api("/api/config/model", { method: "PUT", body: JSON.stringify(body) });
  await fetchHealth(); render();
}

// --- Helpers ---
function badge(s) { return `badge badge--${s || "unknown"}`; }
function ago(iso) { if (!iso) return ""; const s = Math.floor((Date.now() - new Date(iso)) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m` : `${Math.floor(s/3600)}h`; }
function icon(status) { return status === "completed" ? "\u2713" : status === "failed" ? "\u2717" : status === "running" || status === "in_progress" ? "\u25CB" : "\u00B7"; }

function renderTimeline() {
  const el = $("#timeline"); if (!el) return; el.innerHTML = "";
  for (const t of state.tools) {
    // Build arg summary
    const inp = t.input && Object.keys(t.input).length ? t.input : (t.args || null);
    let argStr = "";
    if (inp) {
      argStr = inp.command || inp.path || inp.issueKey || inp.jql || inp.query || inp.pattern || "";
      if (!argStr && Object.keys(inp).length) argStr = Object.entries(inp).map(([k,v]) => k + "=" + JSON.stringify(v)).join(" ").slice(0, 120);
    }
    // Build output
    let resultRaw = t.outputText || "";
    if (!resultRaw && t.output) resultRaw = typeof t.output === "string" ? t.output : JSON.stringify(t.output, null, 2);
    if (!resultRaw && t.result) resultRaw = String(t.result);
    resultRaw = resultRaw.slice(0, 50000);
    const hasAnsi = resultRaw.includes("\x1b[");
    // Build detail content
    const detailChildren = [];
    if (inp && Object.keys(inp).length) {
      detailChildren.push(h("pre", { class: "tool-input" }, JSON.stringify(inp, null, 2)));
    }
    const resultEl = resultRaw ? h("pre", { class: "tool-output", ...(hasAnsi ? { html: ansiToHtml(resultRaw) } : {}) }) : null;
    if (resultEl && !hasAnsi) resultEl.textContent = resultRaw;
    if (resultEl) detailChildren.push(resultEl);
    el.appendChild(h("details", { class: "timeline-tool" },
      h("summary", { class: `tool-summary tool-${t.status}` },
        h("span", { class: "tool-icon" }, icon(t.status)), h("span", { class: "tool-name" }, t.name),
        argStr ? h("span", { class: "tool-args" }, argStr) : null),
      ...detailChildren));
  }
  if (state.thinking) {
    el.appendChild(h("details", { class: "timeline-thinking", ...(state.job?.status === "running" ? { open: "" } : {}) },
      h("summary", { class: "thinking-summary" }, "Thinking"),
      h("pre", { id: "thinking-content", class: "thinking-content" }, state.thinking)));
  }
}

function renderJobStatus() {
  const el = $("#job-info"); if (!el || !state.job) return;
  const j = state.job;
  el.innerHTML = "";
  el.appendChild(h("span", { class: badge(j.status) }, j.status));
  el.appendChild(document.createTextNode(` | ${j.model || "-"} | ${ago(j.createdAt)} ago`));
  if (j.error) el.appendChild(h("span", { class: "job-error" }, " | " + j.error.slice(0, 200)));
}

// --- Views ---
function renderHeader() {
  const ok = state.health?.ok;
  return h("div", { class: "header" },
    h("h1", { on: { click: backToList }, style: "cursor:pointer" }, "Background Agents"),
    h("span", { class: `status ${ok ? "status--ok" : "status--warn"}` }, ok ? "running" : "offline"));
}

function renderStats() {
  const hl = state.health || {};
  return h("div", { class: "grid" },
    h("div", { class: "card" }, h("h3", {}, "Queue"), h("div", { class: "value" }, String(hl.queue ?? 0))),
    h("div", { class: "card" }, h("h3", {}, "Active"), h("div", { class: "value" }, String(hl.active ?? 0))),
    h("div", { class: "card" }, h("h3", {}, "Jobs"), h("div", { class: "value" }, String(hl.jobs ?? 0))),
    h("div", { class: "card clickable", on: { click: () => { const m = prompt("Model:", state.health?.model || ""); if (m) switchModel(m, null); } } },
      h("h3", {}, "Model"), h("div", { class: "value" }, hl.model || "-")),
    h("div", { class: "card clickable", on: { click: () => { const t = prompt("Thinking level:", state.health?.thinkingLevel || "xhigh"); if (t) switchModel(null, t); } } },
      h("h3", {}, "Thinking"), h("div", { class: "value" }, hl.thinkingLevel || "-")));
}

function renderExtensions() {
  const exts = state.health?.extensions || [];
  if (!exts.length) return null;
  return h("div", { class: "extensions-bar" },
    h("span", { class: "ext-label" }, "Extensions:"),
    ...exts.map((e) => h("span", { class: "ext-badge" }, e.id)));
}

function renderTrigger() {
  const issueInput = h("input", { type: "text", placeholder: "Issue key (optional)", on: { input: (e) => { formState.issueKey = e.target.value; } } });
  const modelInput = h("input", { type: "text", placeholder: `Model (default: ${state.health?.model || ""})`, on: { input: (e) => { formState.model = e.target.value; } } });
  const thinkingInput = h("input", { type: "text", placeholder: `Thinking (default: ${state.health?.thinkingLevel || "xhigh"})`, on: { input: (e) => { formState.thinkingLevel = e.target.value; } } });
  const promptArea = h("textarea", { placeholder: "Prompt", rows: "3", on: { input: (e) => { formState.prompt = e.target.value; }, keydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) triggerRun(); } } });
  if (formState.issueKey) issueInput.value = formState.issueKey;
  if (formState.model) modelInput.value = formState.model;
  if (formState.thinkingLevel) thinkingInput.value = formState.thinkingLevel;
  if (formState.prompt) promptArea.value = formState.prompt;
  return h("div", { class: "trigger-form" },
    h("h2", {}, "New Job"),
    h("div", { class: "row" }, issueInput, modelInput, thinkingInput),
    h("div", { class: "row" }, promptArea),
    h("div", { class: "row" }, h("button", { on: { click: triggerRun } }, "Run"), h("span", { style: "color:var(--muted);font-size:11px;margin-left:8px;align-self:center" }, "Cmd+Enter")));
}

function renderJobList() {
  if (!state.jobs.length) return h("div", { class: "jobs" }, h("p", { style: "color:var(--muted)" }, "No jobs yet."));
  return h("div", { class: "jobs" },
    h("table", {},
      h("thead", {}, h("tr", {}, h("th",{},"ID"), h("th",{},"Title"), h("th",{},"Status"), h("th",{},"Model"), h("th",{},"Age"))),
      h("tbody", {}, ...state.jobs.map((j) =>
        h("tr", { on: { click: () => selectJob(j.id) }, style: "cursor:pointer" },
          h("td", {}, h("span", { class: "job-id" }, j.id.slice(4, 20))),
          h("td", {}, j.title || j.kind),
          h("td", {}, h("span", { class: badge(j.status) }, j.status)),
          h("td", { class: "job-model" }, j.model || "-"),
          h("td", {}, ago(j.createdAt)))))));
}

function renderDetail() {
  const j = state.job; if (!j) return h("div", {}, "Loading...");
  const answer = state.chat || j.result || (j.status === "running" ? "" : "(no output)");
  const sessionEvt = state.events.find((e) => e.type === "agent.session_created");

  const followUpModeSelect = h("select", { on: { change: (e) => { followUpMessageMode = e.target.value; } } },
    h("option", { value: "follow_up" }, "follow-up"),
    h("option", { value: "steer" }, "steer"));
  followUpModeSelect.value = followUpMessageMode || "follow_up";
  const followUpModelInput = h("input", { type: "text", placeholder: `Model (${j.model || state.health?.model || ""})`, on: { input: (e) => { followUpModel = e.target.value; } } });
  const followUpThinkingInput = h("input", { type: "text", placeholder: `Thinking (${j.thinkingLevel || state.health?.thinkingLevel || "xhigh"})`, on: { input: (e) => { followUpThinkingLevel = e.target.value; } } });
  if (followUpModel) followUpModelInput.value = followUpModel;
  if (followUpThinkingLevel) followUpThinkingInput.value = followUpThinkingLevel;

  const followUpInput = h("input", {
    id: "follow-up-input", type: "text", placeholder: "Send follow-up message...",
    on: { input: (e) => { followUpText = e.target.value; }, keydown: (e) => { if (e.key === "Enter") sendFollowUp(); } },
  });

  return h("div", { class: "detail" },
    h("div", { class: "actions" },
      h("button", { on: { click: backToList } }, "Back"),
      h("button", { on: { click: () => api(`/api/jobs/${j.id}/cancel`, { method: "POST" }) } }, "Cancel"),
      h("button", { on: { click: async () => { await api(`/api/jobs/${j.id}/reset`, { method: "POST" }); selectJob(j.id, true); } } }, "Reset Session")),
    h("h2", {}, j.title || j.id),
    h("div", { id: "job-info", class: "job-info" },
      h("span", { class: badge(j.status) }, j.status),
      ` | ${sessionEvt?.data?.model || j.model || "-"} | thinking=${sessionEvt?.data?.thinkingLevel || j.thinkingLevel || "-"} | ${ago(j.createdAt)} ago`,
      j.error ? h("span", { class: "job-error" }, " | " + j.error.slice(0, 200)) : null),
    // Tools + session info
    sessionEvt?.data?.tools ? h("div", { class: "session-tools" },
      ...sessionEvt.data.tools.map((t) => h("span", { class: "tool-badge" }, t))) : null,
    // Answer
    h("div", { class: "answer-section" },
      h("h2", {}, "Answer"),
      h("pre", { id: "chat-output", class: "answer-content" }, answer || (j.status === "running" ? "Working..." : ""))),
    // Follow-up input
    h("div", { class: "follow-up" },
      followUpInput,
      followUpModeSelect,
      followUpModelInput,
      followUpThinkingInput,
      h("button", { on: { click: sendFollowUp } }, "Send")),
    // Timeline
    h("div", { class: "timeline-section" },
      h("h2", {}, `Activity (${state.tools.length} tool calls)`),
      h("div", { id: "timeline", class: "timeline" })));
}

function render() {
  const app = $("#app"); app.innerHTML = "";
  app.appendChild(renderHeader());
  if (state.view === "list") {
    app.appendChild(renderStats());
    const exts = renderExtensions(); if (exts) app.appendChild(exts);
    app.appendChild(renderTrigger());
    app.appendChild(renderJobList());
  } else {
    app.appendChild(renderDetail());
    renderTimeline();
  }
}

async function init() {
  await fetchHealth(); await fetchJobs();
  const r = readUrl(); r.jobId ? await selectJob(r.jobId, true) : render();
  setInterval(async () => {
    await fetchHealth(); await fetchJobs();
    if (state.view === "list") {
      const s = $(".grid"); if (s) s.replaceWith(renderStats());
      const j = $(".jobs"); if (j) j.replaceWith(renderJobList());
    }
  }, 5_000);
}
init();
