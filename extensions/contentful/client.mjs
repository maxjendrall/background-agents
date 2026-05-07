import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const API_HOSTS = {
  management: "https://api.contentful.com",
  delivery: "https://cdn.contentful.com",
  preview: "https://preview.contentful.com",
};

function compact(value, max = 800) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s && s.length > max ? `${s.slice(0, max)}…` : s;
}

function fieldSummary(field) {
  const item = field.items ? `[]${field.items.linkType || field.items.type || ""}` : "";
  return {
    id: field.id,
    name: field.name,
    type: `${field.type || "?"}${field.linkType ? `:${field.linkType}` : ""}${item}`,
    required: Boolean(field.required),
    localized: Boolean(field.localized),
    disabled: Boolean(field.disabled),
    omitted: Boolean(field.omitted),
    validations: field.validations || [],
  };
}

function contentTypeSummary(ct) {
  return {
    id: ct.sys?.id,
    name: ct.name,
    description: ct.description || "",
    displayField: ct.displayField || null,
    updatedAt: ct.sys?.updatedAt || null,
    fields: (ct.fields || []).map(fieldSummary),
  };
}

function firstLocaleValue(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const keys = Object.keys(v);
  if (keys.length === 1 && /^[a-z]{2}(-[A-Z]{2})?$/.test(keys[0])) return v[keys[0]];
  return v;
}

function entrySummary(entry) {
  const fields = {};
  for (const [key, value] of Object.entries(entry.fields || {})) {
    const v = firstLocaleValue(value);
    if (v && typeof v === "object") {
      if (v.sys?.id) fields[key] = { linkType: v.sys.linkType, id: v.sys.id, type: v.sys.type };
      else if (Array.isArray(v)) fields[key] = v.slice(0, 5).map((x) => x?.sys?.id ? { linkType: x.sys.linkType, id: x.sys.id, type: x.sys.type } : compact(x, 120));
      else fields[key] = compact(v, 180);
    } else {
      fields[key] = compact(v, 180);
    }
  }
  return {
    id: entry.sys?.id,
    contentType: entry.sys?.contentType?.sys?.id || null,
    updatedAt: entry.sys?.updatedAt || null,
    publishedAt: entry.sys?.publishedAt || null,
    fields,
  };
}

function normalizeQuery(query = {}) {
  if (!query || typeof query !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return out;
}

function safeRelativePath(input) {
  if (!input || typeof input !== "string") return "/";
  if (/^https?:\/\//i.test(input)) throw new Error("Contentful path must be relative, not a full URL");
  if (input.includes("?") || input.includes("#")) throw new Error("Put query params in the query object, not in path");
  const raw = input.startsWith("/") ? input : `/${input}`;
  const segments = raw.split("/").filter(Boolean);
  const safe = [];
  for (const segment of segments) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    if (!decoded || decoded === "." || decoded === "..") throw new Error("Contentful path must not contain dot segments");
    if (["spaces", "environments"].includes(decoded.toLowerCase())) throw new Error("Contentful path is scoped automatically; do not include spaces/environments segments");
    safe.push(encodeURIComponent(decoded));
  }
  return `/${safe.join("/")}`;
}

export class ContentfulClient {
  constructor(config, opts = {}) {
    this.config = config;
    this.spaceId = config.contentful?.spaceId || "";
    const env = config.contentful?.environment || "staging";
    if (env !== "staging") throw new Error("Contentful tools are restricted to the staging environment");
    this.environment = "staging";
    this.tokens = {
      management: config.contentful?.managementToken || "",
      delivery: config.contentful?.deliveryToken || "",
      preview: config.contentful?.previewToken || "",
    };
    this.hostArtifactsDir = opts.hostArtifactsDir;
    this.vmArtifactsDir = opts.vmArtifactsDir || "/home/user/workspace/contentful-artifacts";
  }

  token(api = "management") { return this.tokens[api] || ""; }
  configured(api = "management") { return Boolean(this.spaceId && this.token(api)); }

  apiBase(api = "management") {
    if (!API_HOSTS[api]) throw new Error(`Unknown Contentful API: ${api}. Use management, delivery, or preview.`);
    if (!this.spaceId) throw new Error("CONTENTFUL_SPACE_ID is not configured");
    return `${API_HOSTS[api]}/spaces/${encodeURIComponent(this.spaceId)}/environments/${encodeURIComponent(this.environment)}`;
  }

  async request(api = "management", path = "/", query = {}) {
    const token = this.token(api);
    if (!token) throw new Error(`Contentful ${api} token is not configured`);
    const safePath = safeRelativePath(path);
    const url = new URL(this.apiBase(api) + safePath);
    for (const [key, value] of Object.entries(normalizeQuery(query))) url.searchParams.set(key, value);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 20_000) }; }
    if (!res.ok) {
      const msg = body?.message || body?.details?.errors?.map((e) => e.details || e.name).join("; ") || text.slice(0, 500) || res.statusText;
      throw new Error(`${res.status} ${msg}`);
    }
    return body;
  }

  async saveArtifact(name, data) {
    if (!this.hostArtifactsDir) return null;
    await mkdir(this.hostArtifactsDir, { recursive: true });
    const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
    const hostPath = resolve(this.hostArtifactsDir, safe);
    writeFileSync(hostPath, JSON.stringify(data, null, 2));
    return { hostPath, vmPath: `${this.vmArtifactsDir}/${safe}` };
  }

  async httpGet({ api = "management", path = "/", query = {}, saveAs } = {}) {
    const data = await this.request(api, path, query);
    const artifact = saveAs ? await this.saveArtifact(saveAs, data) : null;
    return { api, spaceId: this.spaceId, environment: this.environment, path, query: normalizeQuery(query), ...(artifact ? { artifact } : {}), data };
  }

  apiHelp() {
    return {
      scope: {
        spaceId: this.spaceId || "(not configured)",
        environment: "staging",
        note: "Tools are hard-restricted to /spaces/{spaceId}/environments/staging. Do not include /spaces or /environments in contentful_http_get paths.",
      },
      preferredTools: [
        { tool: "contentful_list_content_types", use: "Discover content models/data models." },
        { tool: "contentful_get_content_type", use: "Inspect fields and validations for one content type." },
        { tool: "contentful_list_entries", use: "Find staging entries, optionally filtered by contentType." },
        { tool: "contentful_get_entry", use: "Inspect one staging entry by id; save=true stores full JSON in contentful-artifacts." },
      ],
      httpGet: {
        description: "Escape-hatch read-only GET. Paths are relative to /spaces/{spaceId}/environments/staging for management API, or the equivalent staging environment root for preview/delivery.",
        commonManagementPaths: [
          "/content_types",
          "/content_types/{contentTypeId}",
          "/content_types/{contentTypeId}/editor_interface",
          "/entries",
          "/entries/{entryId}",
          "/assets",
          "/assets/{assetId}",
          "/locales",
          "/tags",
        ],
        commonQueryParams: {
          limit: "Number of items, e.g. 20",
          skip: "Pagination offset",
          content_type: "Filter entries by content type id",
          select: "Comma-separated field/sys projection",
          order: "Sort field, e.g. -sys.updatedAt",
          include: "Link include depth for entries/assets",
          "fields.<fieldId>": "Filter on a field, e.g. fields.slug=my-page",
          "sys.id": "Filter by entry id where supported",
        },
        examples: [
          { tool: "contentful_http_get", input: { api: "management", path: "/content_types", query: { limit: 100 } } },
          { tool: "contentful_http_get", input: { api: "management", path: "/content_types/page" } },
          { tool: "contentful_http_get", input: { api: "management", path: "/entries", query: { content_type: "page", limit: 10, order: "-sys.updatedAt" } } },
          { tool: "contentful_http_get", input: { api: "management", path: "/entries/{entryId}" } },
          { tool: "contentful_http_get", input: { api: "management", path: "/locales" } },
        ],
      },
    };
  }

  async listContentTypes({ limit = 100, skip = 0, query = {} } = {}) {
    const data = await this.request("management", "/content_types", { limit, skip, order: "sys.id", ...query });
    return {
      spaceId: this.spaceId,
      environment: this.environment,
      total: data.total,
      skip: data.skip,
      limit: data.limit,
      contentTypes: (data.items || []).map(contentTypeSummary),
    };
  }

  async getContentType(contentTypeId) {
    const data = await this.request("management", `/content_types/${encodeURIComponent(contentTypeId)}`);
    return contentTypeSummary(data);
  }

  async listEntries({ api = "management", contentType, limit = 20, skip = 0, include = 1, select, query = {} } = {}) {
    const q = { limit, skip, include, ...query };
    if (contentType) q.content_type = contentType;
    if (select) q.select = select;
    const data = await this.request(api, "/entries", q);
    return {
      api,
      spaceId: this.spaceId,
      environment: this.environment,
      total: data.total,
      skip: data.skip,
      limit: data.limit,
      entries: (data.items || []).map(entrySummary),
      includes: data.includes ? Object.fromEntries(Object.entries(data.includes).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])) : undefined,
    };
  }

  async getEntry({ api = "management", entryId, include = 2, save = false } = {}) {
    if (!entryId) throw new Error("entryId required");
    const data = await this.request(api, `/entries/${encodeURIComponent(entryId)}`, { include });
    const artifact = save ? await this.saveArtifact(`entry-${entryId}.json`, data) : null;
    return { api, summary: entrySummary(data), ...(artifact ? { artifact } : {}), data };
  }
}
