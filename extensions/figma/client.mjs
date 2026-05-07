import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const FIGMA_API = "https://api.figma.com/v1";
const INLINE_IMAGE_MAX_BYTES = 2_500_000;

function resolveValue(val) {
  if (typeof val === "string" && val.startsWith("ENV:")) return process.env[val.slice(4)] || "";
  return val || "";
}
function safeName(name) { return basename(String(name || "figma")).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "figma"; }
export function parseFileKey(input) {
  const m = String(input || "").match(/figma\.com\/(?:file|design|board)\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  return String(input || "").replace(/[^a-zA-Z0-9]/g, "");
}
export function parseNodeId(input) {
  const s = String(input || "");
  const m = s.match(/[?&]node-id=([^&]+)/);
  if (m) return decodeURIComponent(m[1]).replace(/-/g, ":");
  return s;
}
function rgbaToHex(c) {
  const r = Math.round((c?.r ?? 0) * 255), g = Math.round((c?.g ?? 0) * 255), b = Math.round((c?.b ?? 0) * 255), a = Math.round((c?.a ?? 1) * 255);
  const hex = (n) => n.toString(16).padStart(2, "0");
  return a === 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
}
function truncateNodeTree(node, depth = 2, maxChildren = 20) {
  if (!node) return node;
  const out = { id: node.id, name: node.name, type: node.type };
  if (node.absoluteBoundingBox) out.bounds = node.absoluteBoundingBox;
  if (node.children && depth > 0) {
    out.children = node.children.slice(0, maxChildren).map((c) => truncateNodeTree(c, depth - 1, maxChildren));
    if (node.children.length > maxChildren) out.childrenTruncated = `${node.children.length - maxChildren} more`;
  } else if (node.children) out.childCount = node.children.length;
  return out;
}
function inspectProps(node) {
  const props = { id: node.id, name: node.name, type: node.type, visible: node.visible ?? true };
  if (node.absoluteBoundingBox) { const b = node.absoluteBoundingBox; props.bounds = { x: b.x, y: b.y, width: b.width, height: b.height }; }
  if (node.fills?.length) props.fills = node.fills.map((f) => ({ type: f.type, opacity: f.opacity ?? 1, color: f.color ? rgbaToHex(f.color) : undefined, imageRef: f.imageRef }));
  if (node.strokes?.length) { props.strokes = node.strokes.map((s) => ({ type: s.type, color: s.color ? rgbaToHex(s.color) : undefined })); props.strokeWeight = node.strokeWeight; }
  if (node.effects?.length) props.effects = node.effects.map((e) => ({ type: e.type, radius: e.radius, color: e.color ? rgbaToHex(e.color) : undefined, offset: e.offset, visible: e.visible ?? true }));
  if (node.cornerRadius !== undefined) props.cornerRadius = node.cornerRadius;
  if (node.rectangleCornerRadii) props.cornerRadii = node.rectangleCornerRadii;
  if (node.style) props.textStyle = { fontFamily: node.style.fontFamily, fontSize: node.style.fontSize, fontWeight: node.style.fontWeight, lineHeightPx: node.style.lineHeightPx, letterSpacing: node.style.letterSpacing, textAlignHorizontal: node.style.textAlignHorizontal };
  if (node.characters !== undefined) props.text = node.characters;
  if (node.layoutMode) props.autoLayout = { mode: node.layoutMode, primaryAxisAlignItems: node.primaryAxisAlignItems, counterAxisAlignItems: node.counterAxisAlignItems, paddingLeft: node.paddingLeft, paddingRight: node.paddingRight, paddingTop: node.paddingTop, paddingBottom: node.paddingBottom, itemSpacing: node.itemSpacing };
  if (node.constraints) props.constraints = node.constraints;
  if (node.children?.length) props.children = node.children.map((c) => ({ id: c.id, name: c.name, type: c.type }));
  return props;
}
function walk(node, fn, parent = null) {
  if (!node) return;
  fn(node, parent);
  for (const c of node.children || []) walk(c, fn, node);
}
function findNode(root, id) {
  let found = null; walk(root, (n) => { if (n.id === id) found = n; }); return found;
}
function latestCacheFile(dir, key) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(`${key}.`) && f.endsWith('.json')).map((f) => resolve(dir, f));
  if (!files.length) return null;
  return files.sort((a,b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
function imageMime(format) {
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg';
  if (format === 'svg') return 'image/svg+xml';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return 'application/octet-stream';
}
function textContent(text) { return [{ type: 'text', text }]; }
function pathFor(hostDir, name) { mkdirSync(hostDir, { recursive: true }); return resolve(hostDir, safeName(name)); }

export class FigmaClient {
  constructor(config, opts = {}) { this.config = config; this.hostArtifactsDir = opts.hostArtifactsDir; this.vmArtifactsDir = opts.vmArtifactsDir; }
  get configured() { return Boolean(this.config.figma?.personalAccessToken || process.env.FIGMA_PERSONAL_ACCESS_TOKEN); }
  requireConfig() {
    const f = this.config.figma || {};
    const token = resolveValue(f.personalAccessToken || process.env.FIGMA_PERSONAL_ACCESS_TOKEN || "");
    if (!token) throw new Error("Figma not configured. Set FIGMA_PERSONAL_ACCESS_TOKEN in .env.");
    return { token, outputDir: f.outputDir || process.env.FIGMA_OUTPUT_DIR || "figma-artifacts", teamId: f.teamId || process.env.FIGMA_TEAM_ID || "" };
  }
  dirs() {
    const cfg = this.requireConfig();
    const host = resolve(this.hostArtifactsDir || join(this.config.paths.data, cfg.outputDir));
    const vm = this.vmArtifactsDir || host;
    mkdirSync(host, { recursive: true });
    return { host, vm };
  }
  vmPath(hostPath) { const { host, vm } = this.dirs(); return hostPath.startsWith(host) ? vm + hostPath.slice(host.length) : hostPath; }
  async fetch(path, opts = {}) {
    const cfg = this.requireConfig();
    const res = await fetch(`${FIGMA_API}${path}`, { ...opts, headers: { "X-Figma-Token": cfg.token, ...(opts.headers || {}) } });
    if (!res.ok) { const body = await res.text().catch(() => ""); throw new Error(`Figma API ${res.status}: ${res.statusText}${body ? ` — ${body.slice(0, 1000)}` : ""}`); }
    return res.json();
  }
  async getFile(fileKey, depth = 2) {
    const key = parseFileKey(fileKey); const d = Math.min(Number(depth) || 2, 10);
    const data = await this.fetch(`/files/${key}?depth=${d}`);
    const { host } = this.dirs();
    const fullPath = pathFor(host, `${key}.depth-${d}.json`);
    writeFileSync(fullPath, JSON.stringify(data, null, 2));
    const vmJsonPath = this.vmPath(fullPath);
    const pages = data.document?.children ?? [];
    const frames = [];
    for (const page of pages) for (const child of page.children || []) frames.push({ page: page.name, id: child.id, name: child.name, type: child.type, bounds: child.absoluteBoundingBox });
    const frameLines = frames.slice(0, 80).map((f) => `- ${f.page} / **${f.name}** (${f.type}) id: \`${f.id}\`${f.bounds ? ` ${Math.round(f.bounds.width)}x${Math.round(f.bounds.height)}` : ''}`);
    const summary = [`# ${data.name}`, `Last modified: ${data.lastModified}`, `Version: ${data.version}`, `Pages: ${pages.length}`, `Full Figma JSON saved at: ${vmJsonPath}`, "", "## Pages", ...pages.map((p) => `- ${p.name} id: \`${p.id}\``), "", `## Top-level frames (${frames.length})`, ...frameLines, frames.length > 80 ? `- ... ${frames.length - 80} more frames in ${vmJsonPath}` : "", "", "If the node/info you need is not in this summary, inspect the saved JSON with bash/node/jq or call figma_find_nodes / figma_get_node_subtree / figma_inspect_node."].filter(Boolean).join("\n");
    return { content: textContent(summary), details: { name: data.name, lastModified: data.lastModified, version: data.version, pageCount: pages.length, jsonPath: vmJsonPath, hostJsonPath: fullPath, pages: pages.map((p) => ({ id: p.id, name: p.name })), frames } };
  }
  async getComponents(fileKey) { const data = await this.fetch(`/files/${parseFileKey(fileKey)}/components`); return data.meta?.components ?? []; }
  async getStyles(fileKey) { const data = await this.fetch(`/files/${parseFileKey(fileKey)}/styles`); return data.meta?.styles ?? []; }
  async inspectNode(fileKey, nodeId) { const id = parseNodeId(nodeId); const data = await this.fetch(`/files/${parseFileKey(fileKey)}/nodes?ids=${encodeURIComponent(id)}`); const node = data.nodes?.[id]?.document; if (!node) throw new Error(`Node ${id} not found`); return inspectProps(node); }
  async loadCachedOrFetch(fileKey) {
    const key = parseFileKey(fileKey); const { host } = this.dirs(); let fp = latestCacheFile(host, key);
    if (fp) return { key, data: JSON.parse(readFileSync(fp, 'utf8')), hostPath: fp, vmPath: this.vmPath(fp) };
    const data = await this.fetch(`/files/${key}`);
    fp = pathFor(host, `${key}.full.json`); writeFileSync(fp, JSON.stringify(data, null, 2));
    return { key, data, hostPath: fp, vmPath: this.vmPath(fp) };
  }
  async findNodes(fileKey, query, max = 50) {
    const q = String(query).toLowerCase(); const cached = await this.loadCachedOrFetch(fileKey); const matches = [];
    walk(cached.data.document, (n, parent) => { if (matches.length >= max) return; const hay = `${n.id} ${n.name || ''} ${n.type || ''}`.toLowerCase(); if (hay.includes(q)) matches.push({ id: n.id, name: n.name, type: n.type, parent: parent ? { id: parent.id, name: parent.name, type: parent.type } : null, bounds: n.absoluteBoundingBox }); });
    return { content: textContent(matches.length ? `# Figma node matches (${matches.length})\nFull JSON: ${cached.vmPath}\n\n` + matches.map((m) => `- **${m.name}** (${m.type}) id: \`${m.id}\`${m.parent ? ` parent: ${m.parent.name}` : ''}`).join('\n') : `No nodes matching "${query}". Full JSON: ${cached.vmPath}`), details: { matches, jsonPath: cached.vmPath } };
  }
  async getNodeSubtree(fileKey, nodeId, depth = 3) {
    const id = parseNodeId(nodeId); const d = Math.min(Number(depth) || 3, 10); let node = null; let source = '';
    try { const cached = await this.loadCachedOrFetch(fileKey); node = findNode(cached.data.document, id); source = cached.vmPath; } catch {}
    if (!node) { const data = await this.fetch(`/files/${parseFileKey(fileKey)}/nodes?ids=${encodeURIComponent(id)}`); node = data.nodes?.[id]?.document; source = 'Figma API /nodes'; }
    if (!node) throw new Error(`Node ${id} not found`);
    const subtree = truncateNodeTree(node, d, 50); const { host } = this.dirs(); const fp = pathFor(host, `${parseFileKey(fileKey)}.${safeName(id)}.subtree-depth-${d}.json`); writeFileSync(fp, JSON.stringify(node, null, 2));
    const vmPath = this.vmPath(fp);
    return { content: textContent(`# ${node.name} (${node.type})\nNode id: \`${node.id}\`\nSource: ${source}\nFull subtree JSON saved at: ${vmPath}\n\n\`\`\`json\n${JSON.stringify(subtree, null, 2)}\n\`\`\``), details: { node: subtree, jsonPath: vmPath } };
  }
  async exportAssets(fileKey, nodeIds, format = "png", scale = 2) {
    const key = parseFileKey(fileKey); const ids = nodeIds.map(parseNodeId); const fmt = ["png","svg","pdf","jpg"].includes(format) ? format : "png"; const sc = Math.max(0.01, Math.min(4, Number(scale) || 2));
    const nodeData = await this.fetch(`/files/${key}/nodes?ids=${encodeURIComponent(ids.join(","))}`);
    const missing = new Set(ids.filter((id) => !nodeData.nodes?.[id]?.document)); const exportableIds = ids.filter((id) => !missing.has(id));
    const data = exportableIds.length ? await this.fetch(`/images/${key}?ids=${encodeURIComponent(exportableIds.join(","))}&format=${fmt}&scale=${sc}`) : { images: {} };
    if (data.err) throw new Error(`Figma export error: ${data.err}`);
    const { host } = this.dirs(); const saved = [], failed = [...[...missing].map((nodeId) => ({ nodeId, reason: "Node not found in this Figma file. Use figma_get_file/figma_find_nodes with a current node id." }))];
    for (const [nodeId, url] of Object.entries(data.images || {})) {
      if (!url) { failed.push({ nodeId, reason: "Figma returned no export URL. Node may be hidden, empty, or not exportable." }); continue; }
      try { const res = await fetch(url); if (!res.ok) { failed.push({ nodeId, reason: `HTTP ${res.status}` }); continue; } const buf = Buffer.from(await res.arrayBuffer()); const hostPath = pathFor(host, `${nodeId.replace(/[:/;]/g, "_")}.${fmt}`); writeFileSync(hostPath, buf); saved.push({ nodeId, path: this.vmPath(hostPath), hostPath, bytes: buf.length }); }
      catch (e) { failed.push({ nodeId, reason: e.message || String(e) }); }
    }
    let inlineImage = null;
    if (saved.length && ['png','jpg','svg'].includes(fmt)) {
      const previewScale = Math.min(sc, 0.35);
      try {
        const pData = await this.fetch(`/images/${key}?ids=${encodeURIComponent(saved[0].nodeId)}&format=${fmt}&scale=${previewScale}`);
        const pUrl = pData.images?.[saved[0].nodeId];
        if (pUrl) { const pRes = await fetch(pUrl); const pBuf = Buffer.from(await pRes.arrayBuffer()); if (pBuf.length <= INLINE_IMAGE_MAX_BYTES) inlineImage = { type: 'image', mimeType: imageMime(fmt), data: pBuf.toString('base64') }; }
      } catch {}
    }
    const text = [saved.length ? `## Exported (${saved.length})` : `## Exported`, ...saved.map((s) => `- \`${s.nodeId}\` -> \`${s.path}\` (${s.bytes} bytes)`), failed.length ? `\n## Failed (${failed.length})` : '', ...failed.map((f) => `- \`${f.nodeId}\`: ${f.reason}`), inlineImage ? `\nInline preview attached for ${saved[0].nodeId}. Full file saved on disk.` : saved.length ? `\nUse view_image on the saved path to inspect an exported image.` : ''].filter(Boolean).join('\n');
    return { content: inlineImage ? [...textContent(text), inlineImage] : textContent(text), details: { saved, failed, format: fmt, scale: sc, outputDir: this.dirs().vm } };
  }
  async getComments(fileKey) { const data = await this.fetch(`/files/${parseFileKey(fileKey)}/comments`); return data.comments ?? []; }
  async getImages(fileKey) { const data = await this.fetch(`/files/${parseFileKey(fileKey)}/images`); return data.meta?.images ?? {}; }
  async search(query, teamId) { const cfg = this.requireConfig(); const tid = teamId || cfg.teamId; if (!tid) throw new Error("No Figma teamId configured or provided."); const projects = (await this.fetch(`/teams/${tid}/projects`)).projects ?? []; const files = []; for (const p of projects) { try { const r = await this.fetch(`/projects/${p.id}/files`); files.push(...(r.files ?? []).map((f) => ({ ...f, projectName: p.name, projectId: p.id }))); } catch {} } const q = String(query).toLowerCase(); return files.filter((f) => f.name?.toLowerCase().includes(q) || f.projectName?.toLowerCase().includes(q)); }
}
