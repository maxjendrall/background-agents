export function piAgentsExtensionSource() {
  return String.raw`
module.exports = function(pi) {
  const PORT = process.env.AGENTOS_TOOLS_PORT;
  async function callHost(tool, input) {
    if (!PORT) throw new Error("Host agent tools unavailable: AGENTOS_TOOLS_PORT not set");
    const res = await fetch("http://127.0.0.1:" + PORT + "/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit: "agents", tool, input }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.message || body.error || "Agent host tool failed");
    const result = body.result;
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }], details: result };
  }

  pi.registerTool({
    name: "start_agent",
    description: "Start a child background agent. Fire-and-forget; cannot retrieve its results.",
    parameters: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "Complete task instructions for the child agent." },
        title: { type: "string", description: "Short title for the child job." },
        issueKey: { type: "string", description: "Optional Jira issue key for the child job." },
        model: { type: "string", description: "Optional model override." },
        thinkingLevel: { type: "string", description: "Optional thinking level override." },
        autoComment: { type: "boolean", description: "Whether server should auto-comment final output on Jira." },
        allowDuplicateIssue: { type: "boolean", description: "Allow starting even if the issue already has a queued/running job." }
      },
      required: ["instructions"]
    },
    execute: async (_id, params) => callHost("start_agent", params),
  });
};
`;
}
