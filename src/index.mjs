import { serve } from "@hono/node-server";
import { loadConfig } from "./config.mjs";
import { Processes } from "./core/processes.mjs";
import { loadExtensions } from "./core/extension.mjs";
import { JobStore } from "./jobs/store.mjs";
import { JobRunner } from "./jobs/runner.mjs";
import { PiRuntime } from "./runtime/pi.mjs";
import { createApp } from "./server/app.mjs";
import { JiraClient } from "../extensions/jira/client.mjs";

// Extensions
import { jiraExtension } from "../extensions/jira/index.mjs";
import { githubExtension } from "../extensions/github/index.mjs";
import { repoExtension } from "../extensions/repo/index.mjs";
import { envExtension } from "../extensions/env/index.mjs";
import { browserExtension } from "../extensions/browser/index.mjs";

const config = await loadConfig();
const extensions = loadExtensions([
  jiraExtension(),
  githubExtension(),
  repoExtension(),
  envExtension(),
  browserExtension(),
]);

const store = new JobStore(config);
await store.load();

const processes = new Processes();
const runtime = new PiRuntime({ config, extensions, processes });

async function onJobComplete(job, output) {
  if (!job.issueKey) return;
  if (!job.autoComment && !config.jira.autoComment) return;
  const jira = new JiraClient(config);
  if (!jira.configured) return;
  await jira.addComment(job.issueKey, `Agent completed.\n\n${(output || "(no output)").slice(0, 30_000)}`);
  await store.event(job.id, "jira.commented", { issueKey: job.issueKey });
}

const runner = new JobRunner({ config, store, runtime, onComplete: onJobComplete });
const app = createApp({ config, store, runner, extensions });

const server = serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port });
console.log(`[background-agents] http://${config.server.host}:${config.server.port}`);
console.log(`[background-agents] ui http://${config.server.host}:${config.server.port}/ui`);
if (config.workspace.exists) console.log(`[background-agents] workspace ${config.workspace.path}`);

function shutdown() { runtime.disposeAll(); processes.stopAll(); server.close(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
