export function piViewExtensionSource() {
  return String.raw`
module.exports = function(pi) {
  const fs = require("fs");
  const path = require("path");
  const MAX_INLINE_BYTES = 4_000_000;
  function mimeFor(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
    if (ext === ".svg") return "image/svg+xml";
    return "application/octet-stream";
  }
  pi.registerTool({
    name: "view_image",
    description: "View an image file from disk as an actual image attachment. Use this instead of read() for PNG/JPG/GIF/WebP/SVG files.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (_id, params) => {
      let file = params.path;
      if (!fs.existsSync(file) && file.includes("/figma-assets/")) {
        const alt = file.replace("/figma-assets/", "/figma-artifacts/");
        if (fs.existsSync(alt)) file = alt;
      }
      if (!fs.existsSync(file) && file.includes("/attachments/")) {
        const alt = file.replace("/attachments/", "/jira-artifacts/");
        if (fs.existsSync(alt)) file = alt;
      }
      const st = fs.statSync(file);
      const mimeType = mimeFor(file);
      if (!mimeType.startsWith("image/")) return { content: [{ type: "text", text: file + " is not a supported image type (" + mimeType + ")." }] };
      if (st.size > MAX_INLINE_BYTES) return { content: [{ type: "text", text: "Image is too large to inline (" + st.size + " bytes). Ask the producing tool for a lower-scale preview, or export at a smaller scale. Path: " + file }] };
      const data = fs.readFileSync(file).toString("base64");
      return { content: [{ type: "text", text: "Viewing image " + file + " (" + mimeType + ", " + st.size + " bytes)." }, { type: "image", mimeType, data }], details: { path: file, mimeType, bytes: st.size } };
    },
  });
};
`;
}
