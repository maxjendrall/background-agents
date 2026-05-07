export function piContentfulExtensionSource() {
  return String.raw`
module.exports = function(pi) {
  const PORT = process.env.AGENTOS_TOOLS_PORT;
  async function callHost(tool, input) {
    if (!PORT) throw new Error("Host Contentful tools unavailable: AGENTOS_TOOLS_PORT not set");
    const res = await fetch("http://127.0.0.1:" + PORT + "/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit: "contentful", tool, input }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.message || body.error || "Contentful host tool failed");
    const result = body.result;
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }], details: result };
  }
  function reg(name, description, properties, required, hostTool) {
    pi.registerTool({ name, description, parameters: { type: "object", properties, required }, execute: async (_id, params) => callHost(hostTool || name.replace(/^contentful_/, ""), params) });
  }
  reg("contentful_http_get", "Read-only GET against Contentful management/delivery/preview APIs for the configured staging environment only. Path is relative to /spaces/{space}/environments/staging.", { api: { type: "string", enum: ["management", "delivery", "preview"] }, path: { type: "string" }, query: { type: "object" }, saveAs: { type: "string" } }, ["path"], "http_get");
  reg("contentful_list_content_types", "List Contentful content types/data models in staging.", { limit: { type: "number" }, skip: { type: "number" }, query: { type: "object" } }, [], "list_content_types");
  reg("contentful_get_content_type", "Get one Contentful content type/data model with fields and validations.", { contentTypeId: { type: "string" } }, ["contentTypeId"], "get_content_type");
  reg("contentful_list_entries", "List Contentful entries from management/preview/delivery APIs. Defaults to management on staging.", { api: { type: "string", enum: ["management", "delivery", "preview"] }, contentType: { type: "string" }, limit: { type: "number" }, skip: { type: "number" }, include: { type: "number" }, select: { type: "string" }, query: { type: "object" } }, [], "list_entries");
  reg("contentful_get_entry", "Get one Contentful entry by id. Optionally save full JSON to /home/user/workspace/contentful-artifacts.", { api: { type: "string", enum: ["management", "delivery", "preview"] }, entryId: { type: "string" }, include: { type: "number" }, save: { type: "boolean" } }, ["entryId"], "get_entry");
};
`;
}
