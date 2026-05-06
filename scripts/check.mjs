import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const skip = new Set(["node_modules", ".data", ".git"]);
async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...await collect(p));
    else if (p.endsWith(".mjs")) files.push(p);
  }
  return files;
}

for (const f of await collect(process.cwd())) {
  const ok = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["--check", f], { stdio: "inherit" });
    c.on("close", (code) => resolve(code === 0));
  });
  if (!ok) { console.error(`FAIL ${f}`); process.exit(1); }
}
console.log("ok");
