#!/usr/bin/env node
import { existsSync } from "node:fs";
import { copyFile, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { compactEvents } from "../src/core/events.mjs";

function parseArgs(argv) {
  const out = { dryRun: false, backup: false, jobs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--backup") out.backup = true;
    else if (a === "--job" && argv[i + 1]) out.jobs.push(argv[++i]);
    else if (a.startsWith("--job=")) out.jobs.push(a.slice("--job=".length));
    else if (!a.startsWith("--")) out.jobs.push(a);
  }
  return out;
}

async function loadEvents(file) {
  const text = await readFile(file, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function writeEvents(file, events) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""), "utf8");
  await rename(tmp, file);
}

const args = parseArgs(process.argv.slice(2));
const config = await loadConfig();
const entries = args.jobs.length
  ? args.jobs
  : (await readdir(config.paths.jobs, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

let totalBefore = 0;
let totalAfter = 0;
let changed = 0;

for (const jobId of entries) {
  const file = resolve(config.paths.jobs, jobId, "events.jsonl");
  if (!existsSync(file)) continue;
  const rawText = await readFile(file, "utf8");
  const beforeBytes = Buffer.byteLength(rawText);
  const raw = rawText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const compacted = compactEvents(raw);
  const nextText = compacted.map((e) => JSON.stringify(e)).join("\n") + (compacted.length ? "\n" : "");
  const afterBytes = Buffer.byteLength(nextText);
  totalBefore += beforeBytes;
  totalAfter += afterBytes;
  const didChange = raw.length !== compacted.length || beforeBytes !== afterBytes;
  if (didChange) changed++;
  console.log(`${jobId}: ${raw.length} -> ${compacted.length} events, ${(beforeBytes / 1024 / 1024).toFixed(1)}MB -> ${(afterBytes / 1024 / 1024).toFixed(1)}MB${args.dryRun || !didChange ? "" : " rewritten"}`);
  if (!args.dryRun && didChange) {
    if (args.backup) await copyFile(file, `${file}.bak`);
    await writeEvents(file, compacted);
  }
}

console.log(`total: ${changed} changed, ${(totalBefore / 1024 / 1024).toFixed(1)}MB -> ${(totalAfter / 1024 / 1024).toFixed(1)}MB`);
