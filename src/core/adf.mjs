function escPipe(s) { return String(s || "").replace(/\|/g, "\\|"); }
function clean(s) { return String(s || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); }

function markText(text, marks = []) {
  let out = text || "";
  const link = marks.find((m) => m.type === "link" && m.attrs?.href);
  const code = marks.some((m) => m.type === "code");
  const strong = marks.some((m) => m.type === "strong");
  const em = marks.some((m) => m.type === "em");
  const strike = marks.some((m) => m.type === "strike");

  if (code) out = `\`${out.replace(/`/g, "\\`")}\``;
  if (strong) out = `**${out}**`;
  if (em) out = `_${out}_`;
  if (strike) out = `~~${out}~~`;
  if (link) {
    const href = link.attrs.href;
    out = out.trim() && out !== href ? `[${out}](${href})` : href;
  }
  return out;
}

function inline(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  switch (node.type) {
    case "text": return markText(node.text || "", node.marks || []);
    case "hardBreak": return "\n";
    case "mention": return node.attrs?.text || node.attrs?.displayName || "@user";
    case "emoji": return node.attrs?.text || node.attrs?.shortName || "";
    case "inlineCard": return node.attrs?.url || "";
    case "date": return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "status": return node.attrs?.text ? `**${node.attrs.text}**` : "";
    default: return Array.isArray(node.content) ? node.content.map(inline).join("") : "";
  }
}

function renderList(node, indent = 0, ordered = false) {
  const items = node.content || [];
  return items.map((item, idx) => {
    const marker = ordered ? `${idx + 1}. ` : "- ";
    const pad = " ".repeat(indent);
    const parts = [];
    for (const child of item.content || []) {
      if (child.type === "bulletList") parts.push(renderList(child, indent + 2, false));
      else if (child.type === "orderedList") parts.push(renderList(child, indent + 2, true));
      else parts.push(renderBlock(child, indent + marker.length));
    }
    const body = clean(parts.join("\n"));
    const lines = body.split("\n");
    return pad + marker + (lines[0] || "") + lines.slice(1).map((l) => `\n${pad}${" ".repeat(marker.length)}${l}`).join("");
  }).join("\n");
}

function cellText(cell) {
  return clean((cell.content || []).map((n) => renderBlock(n)).join("<br>"));
}

function renderTable(node) {
  const rows = (node.content || []).filter((r) => r.type === "tableRow");
  if (!rows.length) return "";
  const table = rows.map((row) => (row.content || []).map(cellText));
  const cols = Math.max(...table.map((r) => r.length));
  const norm = table.map((r) => Array.from({ length: cols }, (_, i) => escPipe(r[i] || " ")));
  const firstIsHeader = (rows[0].content || []).some((c) => c.type === "tableHeader");
  const out = [];
  out.push(`| ${norm[0].join(" | ")} |`);
  out.push(`| ${Array.from({ length: cols }, () => "---").join(" | ")} |`);
  for (const row of norm.slice(firstIsHeader ? 1 : 1)) out.push(`| ${row.join(" | ")} |`);
  return out.join("\n");
}

function renderBlock(node, indent = 0) {
  if (!node) return "";
  if (typeof node === "string") return node;
  switch (node.type) {
    case "doc": return (node.content || []).map((n) => renderBlock(n, indent)).filter(Boolean).join("\n\n");
    case "paragraph": return inline(node);
    case "heading": return `${"#".repeat(node.attrs?.level || 2)} ${inline(node)}`;
    case "bulletList": return renderList(node, indent, false);
    case "orderedList": return renderList(node, indent, true);
    case "listItem": return (node.content || []).map((n) => renderBlock(n, indent)).join("\n");
    case "codeBlock": return "```" + (node.attrs?.language || "") + "\n" + inline(node) + "\n```";
    case "blockquote": return clean((node.content || []).map((n) => renderBlock(n, indent)).join("\n")).split("\n").map((l) => `> ${l}`).join("\n");
    case "table": return renderTable(node);
    case "rule": return "---";
    case "panel": return clean((node.content || []).map((n) => renderBlock(n, indent)).join("\n\n"));
    case "mediaSingle":
    case "mediaGroup": return "[media attachment]";
    case "blockCard": return node.attrs?.url || "";
    default: return Array.isArray(node.content) ? node.content.map((n) => renderBlock(n, indent)).filter(Boolean).join("\n\n") : inline(node);
  }
}

export function adfToMarkdown(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  return clean(renderBlock(adf));
}
