#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { JiraClient } from "../extensions/jira/client.mjs";

function usage() {
  console.error(`Usage:
  node --env-file-if-exists=.env scripts/jira-jql.mjs [--count] [--json] [--max N] [--board 3|/board/3] '<jql>'

Examples:
  node --env-file-if-exists=.env scripts/jira-jql.mjs --count 'project = PT AND statusCategory != Done'
  npm run jira:jql -- --count 'labels = agent'
  npm run jira:jql -- --count --board /board/3
  npm run jira:jql -- --board 3 'statusCategory != Done'
  npm run jira:jql -- --max 20 'assignee = currentUser() ORDER BY updated DESC'
`);
}

const args = process.argv.slice(2);
let countOnly = false;
let json = false;
let max = 10;
let board = "";
const parts = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--count" || arg === "-c") countOnly = true;
  else if (arg === "--json") json = true;
  else if (arg === "--max" || arg === "-m") {
    max = Number(args[++i]);
    if (!Number.isFinite(max) || max < 0) throw new Error("--max must be a non-negative number");
  } else if (arg === "--board" || arg === "-b") {
    board = args[++i] || "";
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    parts.push(arg);
  }
}

const jql = parts.join(" ").trim();
if (!jql && !board) { usage(); process.exit(2); }

const config = await loadConfig();
const jira = new JiraClient(config);

if (!jira.configured) {
  console.error("Jira is not configured. Set Jira env vars or complete OAuth first.");
  process.exit(1);
}

try {
  if (countOnly) {
    const result = board ? await jira.countBoard(board, jql) : await jira.countJql(jql);
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.count);
  } else {
    const result = board ? await jira.searchBoard(board, jql, max, ["summary", "status", "assignee", "priority", "updated"]) : await jira.search(jql, max, ["summary", "status", "assignee", "priority", "updated"]);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const issues = result.issues || [];
      for (const issue of issues) {
        const f = issue.fields || {};
        console.log(`${issue.key}\t${f.status?.name || "?"}\t${f.assignee?.displayName || "unassigned"}\t${f.summary || ""}`);
      }
      if (!issues.length) console.log("(no results)");
    }
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
