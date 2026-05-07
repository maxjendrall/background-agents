// Pi extension for reliable filesystem inspection without shell/brush/node -e.

export function piFilesExtensionSource() {
  return `
module.exports = function(pi) {
  const fs = require("fs");
  const pathMod = require("path");

  function safeLimit(n, def, max) {
    n = Number(n || def);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(Math.floor(n), max);
  }

  function entryLine(base, name, withStats) {
    const full = pathMod.join(base, name);
    let st;
    try { st = fs.statSync(full); } catch { return name; }
    const suffix = st.isDirectory() ? "/" : "";
    if (!withStats) return name + suffix;
    return (st.isDirectory() ? "d" : st.isFile() ? "f" : "?") + " " + String(st.size).padStart(8) + " " + name + suffix;
  }

  pi.registerTool({
    name: "list_directory",
    description: "List files/directories at a path without using bash. Prefer this over shell globs, printf, ls pipelines, or node -e for inspection.",
    parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" }, withStats: { type: "boolean" } }, required: ["path"] },
    execute: async (toolCallId, { path, limit, withStats }) => {
      const max = safeLimit(limit, 200, 1000);
      const names = fs.readdirSync(path).sort((a, b) => a.localeCompare(b));
      const lines = names.slice(0, max).map(n => entryLine(path, n, withStats !== false));
      if (names.length > max) lines.push("... " + (names.length - max) + " more");
      return { content: [{ type: "text", text: lines.join("\\n") || "(empty)" }] };
    },
  });

  pi.registerTool({
    name: "find_files",
    description: "Recursively list file paths without using bash. Use for repo exploration. Optional substring filter matches path text.",
    parameters: { type: "object", properties: { path: { type: "string" }, maxDepth: { type: "number" }, limit: { type: "number" }, contains: { type: "string" } }, required: ["path"] },
    execute: async (toolCallId, { path, maxDepth, limit, contains }) => {
      const depthLimit = safeLimit(maxDepth, 3, 12);
      const max = safeLimit(limit, 300, 2000);
      const out = [];
      const needle = String(contains || "").toLowerCase();
      const skip = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);
      function walk(dir, depth) {
        if (out.length >= max || depth > depthLimit) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
        for (const e of entries) {
          if (out.length >= max) return;
          if (skip.has(e.name)) continue;
          const full = pathMod.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (!needle || full.toLowerCase().includes(needle)) out.push(full);
        }
      }
      walk(path, 0);
      if (out.length >= max) out.push("... limit reached");
      return { content: [{ type: "text", text: out.join("\\n") || "(no files)" }] };
    },
  });
};
`;
}
