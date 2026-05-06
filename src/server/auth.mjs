export function auth(c, next) {
  const token = c.get("config")?.server?.token;
  if (!token) return next();
  const header = c.req.header("authorization") || "";
  if (header === `Bearer ${token}`) return next();
  return c.json({ error: "Unauthorized" }, 401);
}
