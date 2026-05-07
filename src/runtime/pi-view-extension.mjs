export function piViewExtensionSource() {
  return String.raw`
module.exports = function(pi) {
  const PORT = process.env.AGENTOS_TOOLS_PORT;
  async function callHost(tool, input) {
    if (!PORT) throw new Error("Host view tools unavailable: AGENTOS_TOOLS_PORT not set");
    const res = await fetch("http://127.0.0.1:" + PORT + "/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit: "view", tool, input }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.message || body.error || "View host tool failed");
    const result = body.result;
    if (result && Array.isArray(result.content)) return result;
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }], details: result };
  }
  pi.registerTool({
    name: "view_image",
    description: "View an image file as an actual image attachment. Use instead of read() for PNG/JPG/GIF/WebP/SVG.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (_id, params) => callHost("image", params),
  });
};
`;
}
