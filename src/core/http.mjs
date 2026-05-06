export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 20_000) }; }
  if (!res.ok) throw new Error(`${res.status} ${body?.message || body?.errorMessages?.join("; ") || res.statusText}`);
  return body;
}

export function basicAuth(email, token) {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}
