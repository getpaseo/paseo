export function buildNativeRouteHistoryHref(pathname: string, params: object | undefined): string {
  const search = new URLSearchParams();
  let hash = "";
  // Read the focused leaf's params; global params can belong to retained routes.
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === "#" && typeof value === "string") {
      hash = value ? `#${encodeURI(value.replace(/^#/, ""))}` : "";
      continue;
    }
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        search.append(key, String(item));
      }
    }
  }
  const query = search.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}
