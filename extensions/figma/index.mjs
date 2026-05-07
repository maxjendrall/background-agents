import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";
import { resolve } from "node:path";
import { FigmaClient } from "./client.mjs";

const FIGMA_TIMEOUT = 300_000;

export function figmaExtension() {
  return {
    id: "figma",
    description: "Figma file inspection, screenshots, assets, styles, and comments",
    toolkits({ config, job }) {
      const hostArtifactsDir = job?.workspacePath ? resolve(job.workspacePath, "figma-artifacts") : undefined;
      const vmArtifactsDir = "/home/user/workspace/figma-artifacts";
      const figma = new FigmaClient(config, { hostArtifactsDir, vmArtifactsDir });
      return [toolKit({
        name: "figma",
        description: "Figma design tools",
        tools: {
          get_file: hostTool({ description: "Get concise Figma file summary and save full JSON to disk.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ fileKey: z.string().min(1), depth: z.number().optional() }), execute: ({ fileKey, depth }) => figma.getFile(fileKey, depth) }),
          find_nodes: hostTool({ description: "Search cached/full Figma JSON for nodes by name, type, or id.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ fileKey: z.string().min(1), query: z.string().min(1), max: z.number().optional() }), execute: ({ fileKey, query, max }) => figma.findNodes(fileKey, query, max) }),
          get_node_subtree: hostTool({ description: "Get a focused Figma node subtree and save full subtree JSON to disk.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ fileKey: z.string().min(1), nodeId: z.string().min(1), depth: z.number().optional() }), execute: ({ fileKey, nodeId, depth }) => figma.getNodeSubtree(fileKey, nodeId, depth) }),
          get_components: hostTool({ description: "List published components in a Figma file.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ fileKey: z.string().min(1) }), execute: async ({ fileKey }) => ({ components: await figma.getComponents(fileKey) }) }),
          get_styles: hostTool({ description: "List published styles in a Figma file.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ fileKey: z.string().min(1) }), execute: async ({ fileKey }) => ({ styles: await figma.getStyles(fileKey) }) }),
          inspect_node: hostTool({ description: "Inspect a Figma node: dimensions, fills, typography, auto-layout, effects.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ fileKey: z.string().min(1), nodeId: z.string().min(1) }), execute: ({ fileKey, nodeId }) => figma.inspectNode(fileKey, nodeId) }),
          export_assets: hostTool({ description: "Export Figma nodes as high-resolution images/assets to disk with readable preview.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ fileKey: z.string().min(1), nodeIds: z.array(z.string()).min(1), format: z.enum(["png", "svg", "pdf", "jpg"]).optional(), scale: z.number().optional() }), execute: ({ fileKey, nodeIds, format, scale }) => figma.exportAssets(fileKey, nodeIds, format, scale) }),
          get_comments: hostTool({ description: "List comments on a Figma file.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ fileKey: z.string().min(1) }), execute: async ({ fileKey }) => ({ comments: await figma.getComments(fileKey) }) }),
          search: hostTool({ description: "Search Figma team files. Requires teamId in config or parameter.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ query: z.string().min(1), teamId: z.string().optional() }), execute: async ({ query, teamId }) => ({ files: await figma.search(query, teamId) }) }),
          get_images: hostTool({ description: "Get image fill URLs used in a Figma file.", timeout: FIGMA_TIMEOUT, inputSchema: z.object({ fileKey: z.string().min(1) }), execute: async ({ fileKey }) => ({ images: await figma.getImages(fileKey) }) }),
        },
      })];
    },
  };
}
