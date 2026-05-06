export function auth(c, next) {
  const token = c.get("config")?.server?.token;
  if (!token) return next();
  // Check header
  const header = c.req.header("authorization") || "";
  if (header === `Bearer ${token}`) return next();
  // Check query param (for SSE/browser access)
  if (c.req.query("token") === token) return next();
  // Check cookie
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(/auth_token=([^;]+)/);
  if (match && match[1] === token) return next();
  return c.json({ error: "Unauthorized" }, 401);
}
