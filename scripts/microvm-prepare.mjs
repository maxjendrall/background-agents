#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { prepareSnapshot } from "../extensions/microvm/manager.mjs";

const args = new Set(process.argv.slice(2));
const force = args.has("--force") || args.has("-f");
const config = await loadConfig();

const result = await prepareSnapshot(config, { force });
console.log(JSON.stringify(result, null, 2));
