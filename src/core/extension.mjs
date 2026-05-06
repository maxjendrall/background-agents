/**
 * Extension interface:
 *
 *   {
 *     id: string,
 *     description?: string,
 *     routes?(app, ctx): void,
 *     toolkits?(ctx): ToolKit[],
 *   }
 *
 * Routes receive server-level context { config, store, runner }.
 * Toolkits receive job-level context { config, job, processes }.
 */

export function loadExtensions(extensions) {
  for (const ext of extensions) {
    if (!ext.id) throw new Error("Extension missing id");
  }
  return extensions;
}

export function registerRoutes(app, ctx, extensions) {
  for (const ext of extensions) {
    if (ext.routes) ext.routes(app, ctx);
  }
}

export function collectToolkits(ctx, extensions) {
  const kits = [];
  for (const ext of extensions) {
    if (ext.toolkits) kits.push(...ext.toolkits(ctx));
  }
  return kits;
}

export function extensionList(extensions) {
  return extensions.map((e) => ({ id: e.id, description: e.description || "" }));
}
