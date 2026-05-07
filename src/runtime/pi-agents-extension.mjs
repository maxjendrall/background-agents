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
    name: "start_jira_agent",
    description: "Start a child agent for a Jira issue. Fire-and-forget; cannot retrieve results.",
    parameters: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "Jira issue key, e.g. PT-1234." },
        instructions: { type: "string", description: "Optional extra instructions. Omit to simply start work." },
        title: { type: "string", description: "Optional child job title." },
        model: { type: "string", description: "Optional model override." },
        thinkingLevel: { type: "string", description: "Optional thinking level override." },
        allowDuplicateIssue: { type: "boolean", description: "Allow even if issue already has a queued/running job." }
      },
      required: ["issueKey"]
    },
    execute: async (_id, params) => callHost("start_jira_agent", params),
  });

  pi.registerTool({
    name: "start_agent",
    description: "Start a generic child agent. Fire-and-forget; cannot retrieve child results.",
    parameters: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "Complete task instructions for the child agent." },
        title: { type: "string", description: "Short title for the child job." },
        model: { type: "string", description: "Optional model override." },
        thinkingLevel: { type: "string", description: "Optional thinking level override." }
      },
      required: ["instructions"]
    },
    execute: async (_id, params) => callHost("start_agent", params),
  });
};
`;
}
