// Pi extension source code that gets written into the Agent OS VFS.
// Registers native Pi tools for Jira so the agent doesn't need bash.

export function piJiraExtensionSource() {
  // This string is eval'd inside the Pi adapter subprocess.
  // It has access to the Node runtime, fetch, and env vars.
  return `
module.exports = function(pi) {
  const CLOUD_ID = process.env.JIRA_CLOUD_ID;
  const BASE = CLOUD_ID ? "https://api.atlassian.com/ex/jira/" + CLOUD_ID : process.env.JIRA_BASE_URL;
  const AUTH_MODE = process.env.JIRA_AUTH_MODE || "none"; // "oauth" or "basic"

  if (!BASE || AUTH_MODE === "none") return;

  async function getToken() {
    if (AUTH_MODE === "basic") {
      return "Basic " + Buffer.from(process.env.JIRA_EMAIL + ":" + process.env.JIRA_API_TOKEN).toString("base64");
    }
    // OAuth: refresh if needed
    const clientId = process.env.JIRA_OAUTH_CLIENT_ID;
    const clientSecret = process.env.JIRA_OAUTH_CLIENT_SECRET;
    const refreshToken = process.env.JIRA_REFRESH_TOKEN;
    if (!clientId || !refreshToken) throw new Error("Jira OAuth not configured");

    const res = await fetch("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error("Jira token refresh failed: " + JSON.stringify(data));
    return "Bearer " + data.access_token;
  }

  async function jiraReq(path, opts) {
    const auth = await getToken();
    const url = BASE + path;
    const res = await fetch(url, { ...opts, headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json", ...(opts?.headers || {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(res.status + " " + text.slice(0, 500));
    return text ? JSON.parse(text) : {};
  }

  pi.registerTool({
    name: "jira_get_issue",
    description: "Fetch a Jira issue by key. Returns summary, status, description, assignee, and other fields.",
    parameters: { type: "object", properties: { issueKey: { type: "string", description: "Jira issue key, e.g. PT-1" } }, required: ["issueKey"] },
    execute: async (toolCallId, { issueKey }) => {
      const issue = await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "?expand=renderedFields");
      const f = issue.fields || {};
      return { content: [{ type: "text", text: JSON.stringify({ key: issue.key, summary: f.summary, status: f.status?.name, assignee: f.assignee?.displayName, priority: f.priority?.name, description: f.description, labels: f.labels, created: f.created, updated: f.updated }, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "jira_get_comments",
    description: "Fetch recent comments on a Jira issue.",
    parameters: { type: "object", properties: { issueKey: { type: "string", description: "Jira issue key" } }, required: ["issueKey"] },
    execute: async (toolCallId, { issueKey }) => {
      const result = await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "/comment?orderBy=-created&maxResults=20");
      const comments = (result.comments || []).map(c => ({ author: c.author?.displayName, created: c.created, body: c.body }));
      return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "jira_search",
    description: "Search Jira issues using JQL.",
    parameters: { type: "object", properties: { jql: { type: "string", description: "JQL query string" }, maxResults: { type: "number", description: "Max results (default 10)" } }, required: ["jql"] },
    execute: async (toolCallId, { jql, maxResults }) => {
      const result = await jiraReq("/rest/api/3/search/jql", { method: "POST", body: JSON.stringify({ jql, maxResults: maxResults || 10, fields: ["summary", "status", "assignee", "priority", "updated"] }) });
      const issues = (result.issues || []).map(i => ({ key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name, assignee: i.fields?.assignee?.displayName, priority: i.fields?.priority?.name }));
      return { content: [{ type: "text", text: JSON.stringify(issues, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "jira_add_comment",
    description: "Add a comment to a Jira issue.",
    parameters: { type: "object", properties: { issueKey: { type: "string", description: "Jira issue key" }, comment: { type: "string", description: "Comment text" } }, required: ["issueKey", "comment"] },
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
    parameters: { type: "object", properties: { issueKey: { type: "string", description: "Jira issue key" } }, required: ["issueKey"] },
    execute: async (toolCallId, { issueKey }) => {
      const result = await jiraReq("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "/transitions");
      const transitions = (result.transitions || []).map(t => ({ id: t.id, name: t.name }));
      return { content: [{ type: "text", text: JSON.stringify(transitions, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "jira_transition_issue",
    description: "Transition a Jira issue to a new status.",
    parameters: { type: "object", properties: { issueKey: { type: "string", description: "Jira issue key" }, transitionId: { type: "string", description: "Transition ID from jira_list_transitions" } }, required: ["issueKey", "transitionId"] },
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
