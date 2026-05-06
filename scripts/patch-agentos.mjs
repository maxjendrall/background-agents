// Patch Agent OS BigInt bug: host filesystem timestamps are floating-point
// milliseconds, but the WASI polyfill passes them to BigInt() which throws
// on non-integer values. Fix: Math.trunc before conversion.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(process.cwd(), "node_modules/@rivet-dev/agent-os-posix/dist/wasi-polyfill.js");
let src;
try { src = readFileSync(file, "utf8"); } catch { console.log("[patch] wasi-polyfill.js not found, skipping"); process.exit(0); }

const before = `BigInt(node.atime) * 1000000n`;
const after = `BigInt(Math.trunc(node.atime || 0)) * 1000000n`;

if (!src.includes(before)) { console.log("[patch] already patched or source changed"); process.exit(0); }

src = src
  .replace(`BigInt(node.atime) * 1000000n`, `BigInt(Math.trunc(node.atime || 0)) * 1000000n`)
  .replace(`BigInt(node.mtime) * 1000000n`, `BigInt(Math.trunc(node.mtime || 0)) * 1000000n`)
  .replace(`BigInt(node.ctime) * 1000000n`, `BigInt(Math.trunc(node.ctime || 0)) * 1000000n`);

writeFileSync(file, src);
console.log("[patch] patched wasi-polyfill.js BigInt timestamp bug");
