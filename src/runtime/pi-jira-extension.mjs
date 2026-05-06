// Pi extension for Jira tools. Returns clean markdown, not raw JSON.

export function piJiraExtensionSource() {
  return `
module.exports = function(pi) {
  const CLOUD_ID = process.env.JIRA_CLOUD_ID;
  const BASE = CLOUD_ID ? "https://api.atlassian.com/ex/jira/" + CLOUD_ID : process.env.JIRA_BASE_URL;
  const AUTH_MODE = process.env.JIRA_AUTH_MODE || "none";
  const ACCESS_TOKEN = process.env.JIRA_ACCESS_TOKEN;

  if (!BASE || AUTH_MODE === "none") return;

  function getAuth() {
    if (AUTH_MODE === "basic") return "Basic " + Buffer.from(process.env.JIRA_EMAIL + ":" + process.env.JIRA_API_TOKEN).toString("base64");
    if (ACCESS_TOKEN) return "Bearer " + ACCESS_TOKEN;
    throw new Error("No Jira access token. Re-authorize at /api/jira/oauth/authorize");
  }

  async function jiraReq(path, opts) {
    const url = BASE + path;
    const res = await fetch(url, { ...opts, headers: { Authorization: getAuth(), Accept: "application/json", "Content-Type": "application/json", ...(opts?.headers || {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(res.status + " " + text.slice(0, 500));
    return text ? JSON.parse(text) : {};
  }

  // --- ADF to plain text ---
  function adfText(node) {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (node.type === "text") return node.text || "";
    if (node.type === "hardBreak") return "\\n";
    if (node.type === "mention") return "@" + (node.attrs?.text || "user");
    if (node.type === "inlineCard") return node.attrs?.url || "";
    if (Array.isArray(node.content)) return node.content.map(adfText).join("");
    return "";
  }
  function adfToMd(adf) {
    if (!adf || typeof adf === "string") return adf || "";
    if (!adf.content) return "";
    return adf.content.map(b => {
      if (b.type === "paragraph") return adfText(b);
      if (b.type === "heading") return "#".repeat(b.attrs?.level||2) + " " + adfText(b);
      if (b.type === "bulletList") return b.content.map(li => "- " + adfText(li)).join("\\n");
      if (b.type === "orderedList") return b.content.map((li,i) => (i+1) + ". " + adfText(li)).join("\\n");
      if (b.type === "codeBlock") return "\`\`\`\\n" + adfText(b) + "\\n\`\`\`";
      return adfText(b);
    }).join("\\n\\n");
  }

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
    name: "jira_add_comment",
    description: "Add a comment to a Jira issue.",
    parameters: { type: "object", properties: { issueKey: { type: "string" }, comment: { type: "string" } }, required: ["issueKey", "comment"] },
    execute: async (toolCallId, { issueKey, comment }) => {
      await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "/comment", {
        method: "POST",
        body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }] } }),
      });
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
