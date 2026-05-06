import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { slug } from "../../src/core/ids.mjs";

export function browserExtension() {
  return {
    id: "browser",
    description: "Browser screenshot and fetch tools",
    toolkits({ config, job }) {
      return [toolKit({
        name: "browser",
        description: "Browser tools for inspecting local or remote pages",
        tools: {
          fetch: hostTool({
            description: "HTTP GET and return text.",
            inputSchema: z.object({ url: z.string() }),
            execute: async ({ url }) => { const r = await fetch(url); return { status: r.status, text: (await r.text()).slice(0, 50_000) }; },
          }),
          screenshot: hostTool({
            description: "Screenshot a URL.",
            inputSchema: z.object({ url: z.string(), name: z.string().optional(), fullPage: z.boolean().default(true) }),
            execute: async ({ url, name, fullPage }) => {
              await mkdir(job.artifactsPath, { recursive: true });
              const file = `${slug(name || url)}.png`;
              const path = resolve(job.artifactsPath, file);
              const browser = await chromium.launch({ headless: config.browser.headless });
              try { const page = await browser.newPage(); await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 }); await page.screenshot({ path, fullPage }); return { path, url }; }
              finally { await browser.close(); }
            },
          }),
        },
      })];
    },
  };
}
