// Pi extension that registers native git tools.
// These call the Agent OS host tools server internally,
// so git runs on the host where the binary exists.

export function piGitExtensionSource() {
  return `
module.exports = function(pi) {
  const TOOLS_PORT = process.env.AGENTOS_TOOLS_PORT;
  if (!TOOLS_PORT) return;

  async function callHostTool(toolkit, tool, input) {
    const res = await fetch("http://127.0.0.1:" + TOOLS_PORT + "/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit, tool, input }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || data.error || JSON.stringify(data));
    return data.result;
  }

  pi.registerTool({
    name: "git_status",
    description: "Show git status for a repository. Shows branch and changed files.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repo path, e.g. /home/user/workspace/repos/petsdelinext__frontend" } } },
    execute: async (toolCallId, { path }) => {
      const result = await callHostTool("git", "status", { path });
      return { content: [{ type: "text", text: result.text || JSON.stringify(result) }] };
    },
  });

  pi.registerTool({
    name: "git_diff",
    description: "Show uncommitted changes in a repository.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repo path" } }, required: ["path"] },
    execute: async (toolCallId, { path }) => {
      const result = await callHostTool("git", "diff", { path });
      return { content: [{ type: "text", text: result.text || JSON.stringify(result) }] };
    },
  });

  pi.registerTool({
    name: "git_commit",
    description: "Stage all changes and commit with a message.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repo path" }, message: { type: "string", description: "Commit message" } }, required: ["path", "message"] },
    execute: async (toolCallId, { path, message }) => {
      const result = await callHostTool("git", "commit", { path, message });
      return { content: [{ type: "text", text: result.text || JSON.stringify(result) }] };
    },
  });

  pi.registerTool({
    name: "git_push",
    description: "Push the current branch to origin.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repo path" } }, required: ["path"] },
    execute: async (toolCallId, { path }) => {
      const result = await callHostTool("git", "push", { path });
      return { content: [{ type: "text", text: result.text || JSON.stringify(result) }] };
    },
  });

  pi.registerTool({
    name: "git_log",
    description: "Show recent git log.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repo path" }, count: { type: "number", description: "Number of commits (default 10)" } } },
    execute: async (toolCallId, { path, count }) => {
      const result = await callHostTool("git", "log", { path, count: count || 10 });
      return { content: [{ type: "text", text: result.text || JSON.stringify(result) }] };
    },
  });
};
`;
}
