// Patch Agent OS BigInt bug: host filesystem timestamps are floating-point
// milliseconds, but the WASI polyfill passes them to BigInt() which throws
// on non-integer values. Fix: Math.trunc before conversion.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(process.cwd(), "node_modules/@rivet-dev/agent-os-posix/dist/wasi-polyfill.js");
let src;
try { src = readFileSync(file, "utf8"); } catch { console.log("[patch] wasi-polyfill.js not found, skipping"); }

const before = `BigInt(node.atime) * 1000000n`;
const after = `BigInt(Math.trunc(node.atime || 0)) * 1000000n`;

if (src) {
  if (!src.includes(before)) {
    console.log("[patch] wasi-polyfill.js already patched or source changed");
  } else {
    src = src
      .replace(`BigInt(node.atime) * 1000000n`, `BigInt(Math.trunc(node.atime || 0)) * 1000000n`)
      .replace(`BigInt(node.mtime) * 1000000n`, `BigInt(Math.trunc(node.mtime || 0)) * 1000000n`)
      .replace(`BigInt(node.ctime) * 1000000n`, `BigInt(Math.trunc(node.ctime || 0)) * 1000000n`);

    writeFileSync(file, src);
    console.log("[patch] patched wasi-polyfill.js BigInt timestamp bug");
  }
}

// Patch ACP client timeout from 120s to 600s
const acpFile = resolve(process.cwd(), "node_modules/@rivet-dev/agent-os-core/dist/acp-client.js");
let acpSrc;
try { acpSrc = readFileSync(acpFile, "utf8"); } catch {}
if (acpSrc?.includes("120_000") && !acpSrc.includes("600_000")) {
  acpSrc = acpSrc.replace("const DEFAULT_TIMEOUT_MS = 120_000;", "const DEFAULT_TIMEOUT_MS = 600_000;");
  writeFileSync(acpFile, acpSrc);
  console.log("[patch] increased ACP timeout to 600s");
}

// Patch host tool reference text. AgentOS advertises host tools as
// `node /usr/local/bin/agentos-*` CLI shims, but Node-based shim execution is
// unreliable in the current AgentOS/brush sandbox. Prefer native Pi wrappers
// and avoid teaching agents to call the shims.
const hostToolsPromptFile = resolve(process.cwd(), "node_modules/@rivet-dev/agent-os-core/dist/host-tools-prompt.js");
let hostToolsPromptSrc;
try { hostToolsPromptSrc = readFileSync(hostToolsPromptFile, "utf8"); } catch {}
if (hostToolsPromptSrc && !hostToolsPromptSrc.includes('export function generateToolReference(toolKits) {\n    return "";')) {
  hostToolsPromptSrc = hostToolsPromptSrc.replace(
    /export function generateToolReference\(toolKits\) \{[\s\S]*?\n\}\n\/\*\*/,
    'export function generateToolReference(toolKits) {\n    return "";\n}\n/**',
  );
  writeFileSync(hostToolsPromptFile, hostToolsPromptSrc);
  console.log("[patch] disabled AgentOS host tool CLI prompt");
}
const originalHostToolLine = 'lines.push(`- \\`node /usr/local/bin/agentos-${tk.name} ${toolName}${flagStr}\\` — ${tool.description}`);';
if (hostToolsPromptSrc?.includes(originalHostToolLine)) {
  hostToolsPromptSrc = hostToolsPromptSrc
    .replace('lines.push("Run `node /usr/local/bin/agentos list-tools` to see all available tools.");', 'lines.push("Prefer native Pi tools when available. Avoid `node /usr/local/bin/agentos-*` CLI shims inside AgentOS unless explicitly instructed; Node-based shims can be unreliable in some sandboxes.");')
    .replace(originalHostToolLine, 'lines.push(`- Host tool ${tk.name}.${toolName}${flagStr} — ${tool.description}`);')
    .replace('lines.push(`- ${ex.description}: \\`node /usr/local/bin/agentos-${tk.name} ${toolName}${flagArgs ? ` ${flagArgs}` : ""}\\``);', 'lines.push(`- ${ex.description}: host tool ${tk.name}.${toolName}${flagArgs ? ` ${flagArgs}` : ""}`);')
    .replace('lines.push(`Run \\`node /usr/local/bin/agentos-${tk.name} <tool> --help\\` for details.`);', 'lines.push(`Prefer native Pi wrappers for this toolkit when present.`);');
  writeFileSync(hostToolsPromptFile, hostToolsPromptSrc);
  console.log("[patch] softened AgentOS host tool CLI prompt");
}
