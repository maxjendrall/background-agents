const PATTERNS = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /Basic\s+[A-Za-z0-9._\-+/=]+/gi,
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9_\-]+/g,
];

export function redact(value) {
  let s = typeof value === "string" ? value : JSON.stringify(value);
  for (const p of PATTERNS) s = s.replace(p, "[redacted]");
  return s;
}

export function trim(text, max = 40_000) {
  if (!text || text.length <= max) return text || "";
  return `${text.slice(0, max)}\n[trimmed ${text.length - max} chars]`;
}

export function errMsg(e) {
  return redact(e instanceof Error ? (e.stack || e.message) : String(e));
}
