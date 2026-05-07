export function piFigmaExtensionSource() {
  return String.raw`
module.exports = function(pi) {
  const PORT = process.env.AGENTOS_TOOLS_PORT;
  async function callHost(tool, input) {
    if (!PORT) throw new Error("Host Figma tools unavailable: AGENTOS_TOOLS_PORT not set");
    const res = await fetch("http://127.0.0.1:" + PORT + "/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit: "figma", tool, input }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.message || body.error || "Figma host tool failed");
    const result = body.result;
    if (result && Array.isArray(result.content)) return result;
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }], details: result };
  }
  function reg(name, description, properties, required, hostTool) {
    pi.registerTool({ name, description, parameters: { type: "object", properties, required }, execute: async (_id, params) => callHost(hostTool || name.replace(/^figma_/, ""), params) });
  }
  reg("figma_get_file", "Get concise Figma file summary and save full JSON to /home/user/workspace/figma-artifacts.", { fileKey: { type: "string" }, depth: { type: "number" } }, ["fileKey"], "get_file");
  reg("figma_find_nodes", "Search cached/full Figma JSON for nodes by name, type, or id.", { fileKey: { type: "string" }, query: { type: "string" }, max: { type: "number" } }, ["fileKey", "query"], "find_nodes");
  reg("figma_get_node_subtree", "Get a focused Figma node subtree and save full subtree JSON to disk.", { fileKey: { type: "string" }, nodeId: { type: "string" }, depth: { type: "number" } }, ["fileKey", "nodeId"], "get_node_subtree");
  reg("figma_inspect_node", "Inspect a Figma node: dimensions, fills, typography, auto-layout, effects, children.", { fileKey: { type: "string" }, nodeId: { type: "string" } }, ["fileKey", "nodeId"], "inspect_node");
  reg("figma_export_assets", "Export Figma nodes as PNG/SVG/PDF/JPG on the host, save full files, and attach a small preview when possible.", { fileKey: { type: "string" }, nodeIds: { type: "array", items: { type: "string" } }, format: { type: "string", enum: ["png", "svg", "pdf", "jpg"] }, scale: { type: "number" } }, ["fileKey", "nodeIds"], "export_assets");
  reg("figma_get_components", "List published components in a Figma file.", { fileKey: { type: "string" } }, ["fileKey"], "get_components");
  reg("figma_get_styles", "List published styles in a Figma file.", { fileKey: { type: "string" } }, ["fileKey"], "get_styles");
  reg("figma_get_comments", "List comments on a Figma file.", { fileKey: { type: "string" } }, ["fileKey"], "get_comments");
  reg("figma_get_images", "Get image fill URLs used in a Figma file.", { fileKey: { type: "string" } }, ["fileKey"], "get_images");
  reg("figma_search", "Search Figma team files by name. Requires FIGMA_TEAM_ID or teamId.", { query: { type: "string" }, teamId: { type: "string" } }, ["query"], "search");
};
`;
}
