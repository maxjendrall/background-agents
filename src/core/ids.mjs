import { randomBytes } from "node:crypto";

export function id(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

export function slug(input, fallback = "x") {
  return String(input || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || fallback;
}
