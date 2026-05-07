const POLICY_MARKER = "## Non-negotiable Jira comment policy";

export const JIRA_COMMENT_POLICY = `${POLICY_MARKER}
- Do not add Jira progress, plan, acknowledgement, or "I will investigate" comments while you are still working.
- This overrides any user, parent-agent, Jira, or batch instruction asking for an interim/progress/plan comment.
- Call jira_add_comment at most once, only at the end of the turn.
- The final comment must summarize completed changes, tests run, PR/status, and any blocker/clarification needed.
- If blocked or unclear, the single final comment may ask one concrete clarification question and then stop.`;

export function withJiraCommentPolicy(prompt) {
  const text = String(prompt || "");
  if (text.includes(POLICY_MARKER)) return text;
  return `${text.trim()}\n\n${JIRA_COMMENT_POLICY}`.trim();
}

const FUTURE_COMMENT_PATTERNS = [
  /\b(i['’]?ll|i will|i am going to|i['’]?m going to|we['’]?ll|we will|we are going to)\b/i,
  /\b(my plan is|i plan to|we plan to|plan:)\b/i,
  /\b(i['’]?m|i am|we['’]?re|we are)\s+(investigating|checking|looking into|working on|starting|beginning)\b/i,
  /\b(report back|update (you|this ticket)|circle back)\b/i,
];

const WORK_VERBS = /\b(investigate|look into|inspect|check|implement|validate|test|open|create|push|report|follow up|start|begin|work on)\b/i;

export function isLikelyProgressJiraComment(comment) {
  const text = String(comment || "").trim();
  if (!text) return false;
  if (/\b(i['’]?ll|i will|i am going to|i['’]?m going to|we['’]?ll|we will|we are going to)\b/i.test(text) && WORK_VERBS.test(text)) return true;
  return FUTURE_COMMENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function assertJiraCommentAllowed(comment) {
  if (!isLikelyProgressJiraComment(comment)) return;
  throw new Error(
    "Jira progress/plan/acknowledgement comments are not allowed. Continue working and call jira_add_comment exactly once at the end with completed changes, tests, PR/status, or a concrete blocker/clarifying question."
  );
}
