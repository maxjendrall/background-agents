const PATTERNS = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /Basic\s+[A-Za-z0-9._\-+/=]+/gi,
  /((?:JIRA|GITHUB|FIGMA|OPENAI|ANTHROPIC|AGENT|AUTH|ACCESS|REFRESH)[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)?)=([^\s\n]+)/gi,
  /("(?:access_token|refresh_token|api_token|token|secret|password)"\s*:\s*")[^"]+("?)/gi,
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9_\-]+/g,
];

export function redact(value) {
  let s = typeof value === "string" ? value : JSON.stringify(value);
  for (const p of PATTERNS) s = s.replace(p, (...m) => {
    if (m.length > 3 && typeof m[1] === "string" && typeof m[2] === "string") return `${m[1]}=[redacted]`;
    return "[redacted]";
  });
  return s;
}

export function redactData(value) {
  if (value == null) return value;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactData);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /(?:token|secret|password|api[_-]?key)/i.test(k) ? "[redacted]" : redactData(v);
    }
    return out;
  }
  return value;
}

export function trim(text, max = 40_000) {
  if (!text || text.length <= max) return text || "";
  return `${text.slice(0, max)}\n[trimmed ${text.length - max} chars]`;
}

export function errMsg(e) {
  return redact(e instanceof Error ? (e.stack || e.message) : String(e));
}
