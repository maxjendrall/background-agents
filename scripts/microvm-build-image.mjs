#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.mjs";

const args = new Set(process.argv.slice(2));
const force = args.has("--force") || args.has("-f");
const config = await loadConfig();
const output = config.microvm.imagePath || resolve(config.paths.data, "microvm", "node-browser-image");
const manifest = resolve(output, "manifest.json");
if (existsSync(manifest) && !force) {
  console.log(JSON.stringify({ output, exists: true }, null, 2));
  process.exit(0);
}
await mkdir(resolve(output, ".."), { recursive: true });
const bin = resolve(config.root, "node_modules", ".bin", "gondolin");
const build = spawnSync(bin, ["build", "--config", resolve(config.root, "config", "microvm-node-browser.json"), "--output", output], {
  cwd: config.root,
  stdio: "inherit",
  env: process.env,
});
if (build.status !== 0) process.exit(build.status || 1);
console.log(JSON.stringify({ output, built: true }, null, 2));
