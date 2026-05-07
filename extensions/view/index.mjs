import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, extname, isAbsolute } from "node:path";
import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";

const MAX_INLINE_BYTES = 4_000_000;
const VM_WORKSPACE = "/home/user/workspace";

function mimeFor(file) {
  const ext = extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function candidatePaths(job, inputPath) {
  const p = String(inputPath || "");
  const out = [];
  const add = (hostPath, vmPath = p) => {
    if (hostPath) out.push({ hostPath, vmPath });
  };

  if (p.startsWith(`${VM_WORKSPACE}/attachments/`)) {
    add(resolve(job.jiraArtifactsDir, p.slice(`${VM_WORKSPACE}/attachments/`.length)), p);
  }
  if (p.startsWith(`${VM_WORKSPACE}/jira-artifacts/`)) {
    add(resolve(job.jiraArtifactsDir, p.slice(`${VM_WORKSPACE}/jira-artifacts/`.length)), p);
  }
  if (p.startsWith(`${VM_WORKSPACE}/figma-artifacts/`)) {
    add(resolve(job.figmaArtifactsDir, p.slice(`${VM_WORKSPACE}/figma-artifacts/`.length)), p);
  }
  if (p.startsWith(`${VM_WORKSPACE}/figma-assets/`)) {
    add(resolve(job.figmaArtifactsDir, p.slice(`${VM_WORKSPACE}/figma-assets/`.length)), p.replace("/figma-assets/", "/figma-artifacts/"));
  }
  if (p.startsWith(`${VM_WORKSPACE}/contentful-artifacts/`)) {
    add(resolve(job.contentfulArtifactsDir, p.slice(`${VM_WORKSPACE}/contentful-artifacts/`.length)), p);
  }
  if (p.startsWith(`${VM_WORKSPACE}/repos/`)) {
    add(resolve(job.workspacePath, "repos", p.slice(`${VM_WORKSPACE}/repos/`.length)), p);
  }
  if (p === `${VM_WORKSPACE}/agents.md`) {
    add(resolve(job.workspacePath, "agents.md"), p);
  }

  // Last-resort host path for already-mapped paths inside the job workspace.
  if (isAbsolute(p) && p.startsWith(job.workspacePath)) add(p, p);

  return out;
}

function resolveImagePath(job, inputPath) {
  const candidates = candidatePaths(job, inputPath);
  const found = candidates.find((c) => existsSync(c.hostPath));
  if (found) return found;
  throw new Error(`Image not found in job artifacts/workspace: ${inputPath}. Tried: ${candidates.map((c) => c.hostPath).join(", ") || "no mapped paths"}`);
}

export function viewExtension() {
  return {
    id: "view",
    description: "Host-side artifact viewing",
    toolkits({ job }) {
      return [toolKit({
        name: "view",
        description: "View job artifacts",
        tools: {
          image: hostTool({
            description: "View an image from job artifacts/workspace as an image attachment.",
            inputSchema: z.object({ path: z.string().min(1) }),
            execute: ({ path }) => {
              const { hostPath, vmPath } = resolveImagePath(job, path);
              const st = statSync(hostPath);
              if (!st.isFile()) throw new Error(`${path} is not a file`);
              const mimeType = mimeFor(hostPath);
              if (!mimeType.startsWith("image/")) throw new Error(`${path} is not a supported image type (${mimeType})`);
              if (st.size > MAX_INLINE_BYTES) {
                return {
                  content: [{ type: "text", text: `Image is too large to inline (${st.size} bytes). Path: ${vmPath}` }],
                  details: { path: vmPath, hostPath, mimeType, bytes: st.size, inlined: false },
                };
              }
              const data = readFileSync(hostPath).toString("base64");
              return {
                content: [
                  { type: "text", text: `Viewing image ${vmPath} (${mimeType}, ${st.size} bytes).` },
                  { type: "image", mimeType, data },
                ],
                details: { path: vmPath, hostPath, mimeType, bytes: st.size, inlined: true },
              };
            },
          }),
        },
      })];
    },
  };
}
