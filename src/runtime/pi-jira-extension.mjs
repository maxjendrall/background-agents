// Pi extension for Jira tools. Returns clean markdown, not raw JSON.

export function piJiraExtensionSource() {
  return `
module.exports = function(pi) {
  const CLOUD_ID = process.env.JIRA_CLOUD_ID;
  const BASE = CLOUD_ID ? "https://api.atlassian.com/ex/jira/" + CLOUD_ID : process.env.JIRA_BASE_URL;
  const AUTH_MODE = process.env.JIRA_AUTH_MODE || "none";
  const ACCESS_TOKEN = process.env.JIRA_ACCESS_TOKEN;
  const HOST_TOOLS_PORT = process.env.AGENTOS_TOOLS_PORT;
  const fs = require("fs");
  const pathMod = require("path");
  let jiraCommentSent = false;

  if (!BASE || AUTH_MODE === "none") return;

  function getAuth() {
    if (AUTH_MODE === "basic") return "Basic " + Buffer.from(process.env.JIRA_EMAIL + ":" + process.env.JIRA_API_TOKEN).toString("base64");
    if (ACCESS_TOKEN) return "Bearer " + ACCESS_TOKEN;
    throw new Error("No Jira access token. Re-authorize at /api/jira/oauth/authorize");
  }

  async function jiraFetch(path, opts) {
    const url = BASE + path;
    return fetch(url, { ...opts, headers: { Authorization: getAuth(), Accept: "application/json", ...(opts?.body ? { "Content-Type": "application/json" } : {}), ...(opts?.headers || {}) } });
  }

  async function jiraReq(path, opts) {
    const res = await jiraFetch(path, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(res.status + " " + text.slice(0, 500));
    return text ? JSON.parse(text) : {};
  }

  async function callHostJira(tool, input) {
    if (!HOST_TOOLS_PORT) throw new Error("Host Jira tools unavailable: AGENTOS_TOOLS_PORT not set");
    const res = await fetch("http://127.0.0.1:" + HOST_TOOLS_PORT + "/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit: "jira", tool, input }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.message || body.error || "Jira host tool failed");
    return body.result;
  }

  function isLikelyProgressComment(comment) {
    const text = String(comment || "").toLowerCase();
    if (!text.trim()) return false;
    const futureStarts = ["i'll ", "i’ll ", "i will ", "i am going to ", "i'm going to ", "we'll ", "we’ll ", "we will ", "we are going to "];
    const workWords = ["investigate", "look into", "inspect", "check", "implement", "validate", "test", "open", "create", "push", "report", "follow up", "start", "begin", "work on"];
    if (futureStarts.some(s => text.includes(s)) && workWords.some(w => text.includes(w))) return true;
    const progressPhrases = [
      "my plan is", "i plan to", "we plan to", "plan:", "i'm investigating", "i’m investigating", "i am investigating",
      "i'm checking", "i’m checking", "i am checking", "i'm looking into", "i’m looking into", "i am looking into",
      "i'm working on", "i’m working on", "i am working on", "we're working on", "we’re working on", "we are working on",
      "report back", "update you", "update this ticket", "circle back"
    ];
    return progressPhrases.some(p => text.includes(p));
  }

  function assertJiraCommentAllowed(comment) {
    if (!isLikelyProgressComment(comment)) return;
    throw new Error("Jira progress/plan/acknowledgement comments are not allowed. Continue working and call jira_add_comment exactly once at the end with completed changes, tests, PR/status, or a concrete blocker/clarifying question.");
  }

  function safeName(name) {
    return pathMod.basename(String(name || "attachment")).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "attachment";
  }

  function fmtAttachments(attachments) {
    if (!attachments?.length) return "(no attachments)";
    return attachments.map(a => "- **" + a.filename + "** (id: " + a.id + ", " + (a.mimeType || "unknown") + ", " + (a.size || 0) + " bytes) by " + (a.author?.displayName || "?")).join("\\n");
  }

  // --- ADF to markdown ---
  function clean(s) { return String(s || "").replace(/[ \t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim(); }
  function escPipe(s) { return String(s || "").replace(/\|/g, "\\|"); }
  function markText(text, marks) {
    let out = text || "";
    marks = marks || [];
    const link = marks.find(m => m.type === "link" && m.attrs && m.attrs.href);
    if (marks.some(m => m.type === "code")) { const tick = String.fromCharCode(96); out = tick + out.replace(new RegExp(tick, "g"), String.fromCharCode(92) + tick) + tick; }
    if (marks.some(m => m.type === "strong")) out = "**" + out + "**";
    if (marks.some(m => m.type === "em")) out = "_" + out + "_";
    if (marks.some(m => m.type === "strike")) out = "~~" + out + "~~";
    if (link) out = out.trim() && out !== link.attrs.href ? "[" + out + "](" + link.attrs.href + ")" : link.attrs.href;
    return out;
  }
  function adfInline(node) {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (node.type === "text") return markText(node.text || "", node.marks || []);
    if (node.type === "hardBreak") return "\\n";
    if (node.type === "mention") return node.attrs?.text || node.attrs?.displayName || "@user";
    if (node.type === "emoji") return node.attrs?.text || node.attrs?.shortName || "";
    if (node.type === "inlineCard") return node.attrs?.url || "";
    if (node.type === "date") return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
    if (node.type === "status") return node.attrs?.text ? "**" + node.attrs.text + "**" : "";
    if (Array.isArray(node.content)) return node.content.map(adfInline).join("");
    return "";
  }
  function renderList(node, indent, ordered) {
    indent = indent || 0;
    const items = node.content || [];
    return items.map((item, idx) => {
      const marker = ordered ? (idx + 1) + ". " : "- ";
      const pad = " ".repeat(indent);
      const parts = [];
      for (const child of (item.content || [])) {
        if (child.type === "bulletList") parts.push(renderList(child, indent + 2, false));
        else if (child.type === "orderedList") parts.push(renderList(child, indent + 2, true));
        else parts.push(adfBlock(child, indent + marker.length));
      }
      const body = clean(parts.join("\\n"));
      const lines = body.split("\\n");
      return pad + marker + (lines[0] || "") + lines.slice(1).map(l => "\\n" + pad + " ".repeat(marker.length) + l).join("");
    }).join("\\n");
  }
  function cellText(cell) { return clean((cell.content || []).map(n => adfBlock(n)).join("<br>")); }
  function renderTable(node) {
    const rows = (node.content || []).filter(r => r.type === "tableRow");
    if (!rows.length) return "";
    const table = rows.map(row => (row.content || []).map(cellText));
    const cols = Math.max(...table.map(r => r.length));
    const norm = table.map(r => Array.from({ length: cols }, (_, i) => escPipe(r[i] || " ")));
    const out = [];
    out.push("| " + norm[0].join(" | ") + " |");
    out.push("| " + Array.from({ length: cols }, () => "---").join(" | ") + " |");
    for (const row of norm.slice(1)) out.push("| " + row.join(" | ") + " |");
    return out.join("\\n");
  }
  function adfBlock(node, indent) {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (node.type === "doc") return (node.content || []).map(n => adfBlock(n, indent)).filter(Boolean).join("\\n\\n");
    if (node.type === "paragraph") return adfInline(node);
    if (node.type === "heading") return "#".repeat(node.attrs?.level || 2) + " " + adfInline(node);
    if (node.type === "bulletList") return renderList(node, indent || 0, false);
    if (node.type === "orderedList") return renderList(node, indent || 0, true);
    if (node.type === "codeBlock") { const fence = String.fromCharCode(96,96,96); return fence + (node.attrs?.language || "") + "\\n" + adfInline(node) + "\\n" + fence; }
    if (node.type === "blockquote") return clean((node.content || []).map(n => adfBlock(n, indent)).join("\\n")).split("\\n").map(l => "> " + l).join("\\n");
    if (node.type === "table") return renderTable(node);
    if (node.type === "rule") return "---";
    if (node.type === "blockCard") return node.attrs?.url || "";
    if (node.type === "mediaSingle" || node.type === "mediaGroup") return "[media attachment]";
    if (Array.isArray(node.content)) return node.content.map(n => adfBlock(n, indent)).filter(Boolean).join("\\n\\n");
    return adfInline(node);
  }
  function adfToMd(adf) { return clean(adfBlock(adf)); }

  function fmtIssue(issue) {
    const f = issue.fields || {};
    return [
      "# " + issue.key + ": " + (f.summary || "Untitled"),
      "",
      "- **Status**: " + (f.status?.name || "?"),
      "- **Priority**: " + (f.priority?.name || "?"),
      "- **Assignee**: " + (f.assignee?.displayName || "Unassigned"),
      "- **Reporter**: " + (f.reporter?.displayName || f.creator?.displayName || "?"),
      "- **Type**: " + (f.issuetype?.name || "?"),
      "- **Labels**: " + (f.labels?.length ? f.labels.join(", ") : "none"),
      "- **Created**: " + (f.created || "?"),
      "- **Updated**: " + (f.updated || "?"),
      f.duedate ? "- **Due**: " + f.duedate : "",
      f.parent ? "- **Parent**: " + f.parent.key + " " + (f.parent.fields?.summary || "") : "",
      f.attachment?.length ? "- **Attachments**: " + f.attachment.length : "",
      f.attachment?.length ? "" : "",
      f.attachment?.length ? "## Attachments" : "",
      f.attachment?.length ? "" : "",
      f.attachment?.length ? fmtAttachments(f.attachment) : "",
      "",
      "## Description",
      "",
      adfToMd(f.description) || "(no description)",
    ].filter(l => l !== false && l !== "").join("\\n");
  }

  function fmtComment(c) {
    return "**" + (c.author?.displayName || "?") + "** (" + (c.created?.slice(0,16).replace("T"," ") || "") + "):\\n" + (adfToMd(c.body) || "(empty)");
  }

  pi.registerTool({
    name: "jira_get_issue",
    description: "Fetch a Jira issue. Returns formatted summary, status, description, and metadata.",
    parameters: { type: "object", properties: { issueKey: { type: "string", description: "e.g. PT-1" } }, required: ["issueKey"] },
    execute: async (toolCallId, { issueKey }) => {
      const issue = await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "?expand=renderedFields");
      return { content: [{ type: "text", text: fmtIssue(issue) }] };
    },
  });

  pi.registerTool({
    name: "jira_get_comments",
    description: "Fetch recent comments on a Jira issue.",
    parameters: { type: "object", properties: { issueKey: { type: "string" } }, required: ["issueKey"] },
    execute: async (toolCallId, { issueKey }) => {
      const result = await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "/comment?orderBy=-created&maxResults=20");
      const comments = (result.comments || []);
      if (!comments.length) return { content: [{ type: "text", text: "(no comments)" }] };
      return { content: [{ type: "text", text: comments.map(fmtComment).join("\\n\\n---\\n\\n") }] };
    },
  });



  pi.registerTool({
    name: "jira_list_attachments",
    description: "List attachments on a Jira issue, including attachment ids for download.",
    parameters: { type: "object", properties: { issueKey: { type: "string", description: "e.g. PT-1" } }, required: ["issueKey"] },
    execute: async (toolCallId, { issueKey }) => {
      const issue = await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "?fields=attachment");
      return { content: [{ type: "text", text: fmtAttachments(issue.fields?.attachment || []) }] };
    },
  });

  pi.registerTool({
    name: "jira_download_attachment",
    description: "Download a Jira attachment by id into /home/user/workspace/attachments and return the local file path. Use after jira_list_attachments.",
    parameters: { type: "object", properties: { attachmentId: { type: "string" } }, required: ["attachmentId"] },
    execute: async (toolCallId, { attachmentId }) => {
      const out = await callHostJira("download_attachment", { attachmentId });
      const p = out.vmPath || (out.path ? out.path.replace(/.*\/jira-artifacts\//, "/home/user/workspace/jira-artifacts/") : "");
      return { content: [{ type: "text", text: "Downloaded " + (out.filename || attachmentId) + " (" + (out.mimeType || "unknown") + ") to " + p }], details: out };
    },
  });


  function boardId(input) {
    const m = String(input || "").match(/(?:^|\\/)board\\/(\\d+)$|^(\\d+)$/);
    return m ? (m[1] || m[2]) : "";
  }
  async function boardJql(board) {
    const id = boardId(board);
    if (!id) throw new Error("board id required, e.g. 3 or /board/3");
    const cfg = await jiraReq("/rest/agile/1.0/board/" + encodeURIComponent(id) + "/configuration");
    const filterId = cfg.filter?.id;
    if (!filterId) throw new Error("Board " + id + " does not expose a filter id");
    const filter = await jiraReq("/rest/api/3/filter/" + encodeURIComponent(filterId));
    if (!filter.jql) throw new Error("Filter " + filterId + " for board " + id + " has no JQL");
    return { boardId: id, filterId, filterName: filter.name || cfg.filter?.name || null, jql: filter.jql };
  }
  function combineJql(baseJql, extraJql) {
    return extraJql && extraJql.trim() ? "(" + baseJql + ") AND (" + extraJql + ")" : baseJql;
  }

  pi.registerTool({
    name: "jira_search",
    description: "Search Jira issues with JQL. Returns a formatted list.",
    parameters: { type: "object", properties: { jql: { type: "string" }, maxResults: { type: "number" } }, required: ["jql"] },
    execute: async (toolCallId, { jql, maxResults }) => {
      const result = await jiraReq("/rest/api/3/search/jql", { method: "POST", body: JSON.stringify({ jql, maxResults: maxResults || 10, fields: ["summary", "status", "assignee", "priority", "updated"] }) });
      const issues = (result.issues || []);
      if (!issues.length) return { content: [{ type: "text", text: "(no results)" }] };
      const lines = issues.map(i => {
        const f = i.fields || {};
        return "- **" + i.key + "**: " + (f.summary||"?") + " [" + (f.status?.name||"?") + "] (" + (f.assignee?.displayName||"unassigned") + ")";
      });
      return { content: [{ type: "text", text: lines.join("\\n") }] };
    },
  });

  pi.registerTool({
    name: "jira_count",
    description: "Count issues matching a JQL query without fetching issue details.",
    parameters: { type: "object", properties: { jql: { type: "string" } }, required: ["jql"] },
    execute: async (toolCallId, { jql }) => {
      let result;
      try {
        result = await jiraReq("/rest/api/3/search/approximate-count", { method: "POST", body: JSON.stringify({ jql }) });
        return { content: [{ type: "text", text: String(result.count || 0) + " issues (approximate)" }] };
      } catch (e) {
        result = await jiraReq("/rest/api/3/search", { method: "POST", body: JSON.stringify({ jql, maxResults: 0, fields: [] }) });
        return { content: [{ type: "text", text: String(result.total || 0) + " issues" }] };
      }
    },
  });

  pi.registerTool({
    name: "jira_board_count",
    description: "Count issues in a Jira board filter, optionally ANDed with extra JQL. Board can be 3 or /board/3.",
    parameters: { type: "object", properties: { board: { type: "string" }, jql: { type: "string" } }, required: ["board"] },
    execute: async (toolCallId, { board, jql }) => {
      const b = await boardJql(board);
      const effectiveJql = combineJql(b.jql, jql || "");
      let result;
      try {
        result = await jiraReq("/rest/api/3/search/approximate-count", { method: "POST", body: JSON.stringify({ jql: effectiveJql }) });
        return { content: [{ type: "text", text: String(result.count || 0) + " issues in board " + b.boardId + " (approximate)" }] };
      } catch (e) {
        result = await jiraReq("/rest/api/3/search", { method: "POST", body: JSON.stringify({ jql: effectiveJql, maxResults: 0, fields: [] }) });
        return { content: [{ type: "text", text: String(result.total || 0) + " issues in board " + b.boardId }] };
      }
    },
  });

  pi.registerTool({
    name: "jira_board_jql",
    description: "Resolve a Jira board id or /board/3 path to its filter JQL.",
    parameters: { type: "object", properties: { board: { type: "string" } }, required: ["board"] },
    execute: async (toolCallId, { board }) => {
      const b = await boardJql(board);
      return { content: [{ type: "text", text: "Board " + b.boardId + " filter " + b.filterId + " (" + (b.filterName || "unnamed") + "):\\n" + b.jql }] };
    },
  });


  pi.registerTool({
    name: "jira_add_comment",
    description: "Add a comment to a Jira issue.",
    parameters: { type: "object", properties: { issueKey: { type: "string" }, comment: { type: "string" } }, required: ["issueKey", "comment"] },
    execute: async (toolCallId, { issueKey, comment }) => {
      if (jiraCommentSent) throw new Error("A Jira comment was already added in this turn. Do not add another one unless a new external follow-up starts a new turn.");
      assertJiraCommentAllowed(comment);
      await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "/comment", {
        method: "POST",
        body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }] } }),
      });
      jiraCommentSent = true;
      return { content: [{ type: "text", text: "Comment added to " + issueKey }] };
    },
  });

  pi.registerTool({
    name: "jira_list_transitions",
    description: "List available workflow transitions for a Jira issue.",
    parameters: { type: "object", properties: { issueKey: { type: "string" } }, required: ["issueKey"] },
    execute: async (toolCallId, { issueKey }) => {
      const result = await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "/transitions");
      const transitions = (result.transitions || []);
      if (!transitions.length) return { content: [{ type: "text", text: "(no transitions available)" }] };
      return { content: [{ type: "text", text: transitions.map(t => "- **" + t.name + "** (id: " + t.id + ")").join("\\n") }] };
    },
  });

  pi.registerTool({
    name: "jira_transition_issue",
    description: "Transition a Jira issue to a new status.",
    parameters: { type: "object", properties: { issueKey: { type: "string" }, transitionId: { type: "string" } }, required: ["issueKey", "transitionId"] },
    execute: async (toolCallId, { issueKey, transitionId }) => {
      await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "/transitions", {
        method: "POST",
        body: JSON.stringify({ transition: { id: transitionId } }),
      });
      return { content: [{ type: "text", text: "Transitioned " + issueKey }] };
    },
  });
};
`;
}
