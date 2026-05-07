// Format Jira API responses as clean markdown for the agent
import { adfToMarkdown } from "../../src/core/adf.mjs";

export function formatIssue(issue) {
  if (!issue) return "(no issue data)";
  const f = issue.fields || {};
  const desc = adfToMarkdown(f.description) || "(no description)";
  const lines = [
    `# ${issue.key}: ${f.summary || "Untitled"}`,
    "",
    `- **Status**: ${f.status?.name || "?"}`,
    `- **Priority**: ${f.priority?.name || "?"}`,
    `- **Assignee**: ${f.assignee?.displayName || "Unassigned"}`,
    `- **Reporter**: ${f.reporter?.displayName || f.creator?.displayName || "?"}`,
    `- **Type**: ${f.issuetype?.name || "?"}`,
    `- **Labels**: ${f.labels?.length ? f.labels.join(", ") : "none"}`,
    `- **Created**: ${f.created || "?"}`,
    `- **Updated**: ${f.updated || "?"}`,
  ];
  if (f.duedate) lines.push(`- **Due**: ${f.duedate}`);
  if (f.parent) lines.push(`- **Parent**: ${f.parent.key} ${f.parent.fields?.summary || ""}`);
  if (f.attachment?.length) {
    lines.push(`- **Attachments**: ${f.attachment.length}`);
    lines.push("", "## Attachments", "");
    for (const a of f.attachment) {
      lines.push(`- **${a.filename}** (id: ${a.id}, ${a.mimeType || "unknown"}, ${a.size || 0} bytes) by ${a.author?.displayName || "?"}`);
    }
  }
  lines.push("", "## Description", "", desc);
  return lines.join("\n");
}

export function formatComment(comment) {
  const author = comment.author?.displayName || "Unknown";
  const date = comment.created?.slice(0, 16).replace("T", " ") || "";
  const body = adfToMarkdown(comment.body) || "(empty)";
  return `**${author}** (${date}):\n${body}`;
}

export function formatComments(commentsResponse) {
  const comments = commentsResponse?.comments || commentsResponse || [];
  if (!comments.length) return "(no comments)";
  return comments.map(formatComment).join("\n\n---\n\n");
}

export function formatIssueList(issues) {
  if (!issues?.length) return "(no results)";
  return issues.map((i) => {
    const f = i.fields || {};
    return `- **${i.key}**: ${f.summary || "?"} [${f.status?.name || "?"}] (${f.assignee?.displayName || "unassigned"})`;
  }).join("\n");
}

export function formatTransitions(transitions) {
  if (!transitions?.length) return "(no transitions available)";
  return transitions.map((t) => `- **${t.name}** (id: ${t.id})`).join("\n");
}
