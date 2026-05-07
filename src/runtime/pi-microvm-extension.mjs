// Pi extension for explicit Gondolin MicroVM tools.
// These delegate to the host microvm toolkit over AgentOS's host tools server.

export function piMicroVmExtensionSource() {
  return `
module.exports = function(pi) {
  const PORT = process.env.AGENTOS_TOOLS_PORT;
  if (!PORT) return;

  async function callHost(tool, input) {
    const res = await fetch("http://127.0.0.1:" + PORT + "/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit: "microvm", tool, input }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || data.error || JSON.stringify(data));
    return data.result;
  }

  function bashText(r) {
    return [
      "exitCode: " + r.exitCode,
      r.stdout ? "\nstdout:\n" + r.stdout : "",
      r.stderr ? "\nstderr:\n" + r.stderr : "",
    ].filter(Boolean).join("\n").trim();
  }

  pi.registerTool({
    name: "vm_bash",
    description: "Run a shell command inside the per-job Gondolin MicroVM. Use for builds/tests/node/npm/yarn/agent-browser. Workspace is mounted at /workspace; repo paths mirror /home/user/workspace under /workspace.",
    parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string", description: "Guest cwd, default /workspace" }, timeout: { type: "number", description: "Timeout in seconds" }, env: { type: "object" } }, required: ["command"] },
    execute: async (_id, params) => {
      const r = await callHost("bash", { cwd: "/workspace", timeout: 120, env: {}, ...params });
      return { content: [{ type: "text", text: bashText(r) }], details: r };
    },
  });

  pi.registerTool({
    name: "vm_read",
    description: "Read a text file from the MicroVM workspace. Use /workspace paths or /home/user/workspace paths.",
    parameters: { type: "object", properties: { path: { type: "string" }, cwd: { type: "string" }, maxBytes: { type: "number" } }, required: ["path"] },
    execute: async (_id, params) => {
      const r = await callHost("read", { cwd: "/workspace", maxBytes: 200000, ...params });
      return { content: [{ type: "text", text: r.text }], details: r };
    },
  });

  pi.registerTool({
    name: "vm_write",
    description: "Write a text file in the MicroVM workspace. Use /workspace paths or /home/user/workspace paths.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, cwd: { type: "string" } }, required: ["path", "content"] },
    execute: async (_id, params) => {
      const r = await callHost("write", { cwd: "/workspace", ...params });
      return { content: [{ type: "text", text: "Wrote " + r.bytes + " bytes to " + r.path }], details: r };
    },
  });

  pi.registerTool({
    name: "vm_edit",
    description: "Replace exact text in a MicroVM workspace file. Use /workspace paths or /home/user/workspace paths.",
    parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, cwd: { type: "string" } }, required: ["path", "oldText", "newText"] },
    execute: async (_id, params) => {
      const r = await callHost("edit", { cwd: "/workspace", ...params });
      return { content: [{ type: "text", text: "Edited " + r.path }], details: r };
    },
  });
};
`;
}
