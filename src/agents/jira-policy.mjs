const POLICY_MARKER = "## Jira comment instruction";
const OLD_POLICY_MARKER = "## Non-negotiable Jira comment policy";

export const JIRA_COMMENT_POLICY = `${POLICY_MARKER}
Add exactly one jira_add_comment at the end of your turn. Do not add progress, plan, or acknowledgement comments while you are still working.`;

function stripOldPolicy(prompt) {
  const text = String(prompt || "");
  const idx = text.indexOf(OLD_POLICY_MARKER);
  return idx >= 0 ? text.slice(0, idx).trim() : text;
}

export function withJiraCommentPolicy(prompt) {
  const text = stripOldPolicy(prompt);
  if (text.includes(POLICY_MARKER)) return text;
  return `${text.trim()}\n\n${JIRA_COMMENT_POLICY}`.trim();
}
