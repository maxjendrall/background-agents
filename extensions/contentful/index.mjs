import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { resolve } from "node:path";
import { ContentfulClient } from "./client.mjs";

const CONTENTFUL_TIMEOUT = 120_000;
const Api = z.enum(["management", "delivery", "preview"]);
const JsonQuery = z.record(z.string(), z.any()).default({});

export function contentfulExtension() {
  return {
    id: "contentful",
    description: "Contentful staging environment and content model inspection tools",
    toolkits({ config, job }) {
      const hostArtifactsDir = job?.workspacePath ? resolve(job.workspacePath, "contentful-artifacts") : undefined;
      const vmArtifactsDir = "/home/user/workspace/contentful-artifacts";
      const contentful = new ContentfulClient(config, { hostArtifactsDir, vmArtifactsDir });
      return [toolKit({
        name: "contentful",
        description: "Read-only Contentful HTTP/API inspection tools for staging content and data models",
        tools: {
          http_get: hostTool({
            description: "Read-only GET against Contentful management/delivery/preview APIs for the configured space/environment. Use for ad-hoc inspection; path is relative to /spaces/{space}/environments/{env}.",
            timeout: CONTENTFUL_TIMEOUT,
            inputSchema: z.object({ api: Api.default("management"), path: z.string().min(1), query: JsonQuery, saveAs: z.string().optional() }),
            execute: (input) => contentful.httpGet(input),
          }),
          list_content_types: hostTool({
            description: "List Contentful content types (data models) in the configured staging environment.",
            timeout: CONTENTFUL_TIMEOUT,
            inputSchema: z.object({ limit: z.number().default(100), skip: z.number().default(0), query: JsonQuery }),
            execute: (input) => contentful.listContentTypes(input),
          }),
          get_content_type: hostTool({
            description: "Get one Contentful content type/data model with field definitions and validations.",
            timeout: CONTENTFUL_TIMEOUT,
            inputSchema: z.object({ contentTypeId: z.string().min(1) }),
            execute: ({ contentTypeId }) => contentful.getContentType(contentTypeId),
          }),
          list_entries: hostTool({
            description: "List Contentful entries from preview/delivery/management APIs. Defaults to preview/staging for draft-capable inspection.",
            timeout: CONTENTFUL_TIMEOUT,
            inputSchema: z.object({ api: Api.default("preview"), contentType: z.string().optional(), limit: z.number().default(20), skip: z.number().default(0), include: z.number().default(1), select: z.string().optional(), query: JsonQuery }),
            execute: (input) => contentful.listEntries(input),
          }),
          get_entry: hostTool({
            description: "Get a single Contentful entry by id from preview/delivery/management APIs. Optionally saves full JSON to contentful-artifacts.",
            timeout: CONTENTFUL_TIMEOUT,
            inputSchema: z.object({ api: Api.default("preview"), entryId: z.string().min(1), include: z.number().default(2), save: z.boolean().default(false) }),
            execute: (input) => contentful.getEntry(input),
          }),
        },
      })];
    },
  };
}
