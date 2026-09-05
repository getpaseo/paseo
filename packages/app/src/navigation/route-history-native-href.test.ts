import { expect, it, vi } from "vitest";
import { buildNativeRouteHistoryHref } from "./route-history-native-href";
import { normalizeRouteHistoryHref } from "./route-history-state";

it("preserves a native plugin route's query and fragment without echoed path params", () => {
  const href = buildNativeRouteHistoryHref("/h/host/plugin/example/main", {
    serverId: "host",
    pluginId: "example",
    surfaceId: "main",
    filter: ["open", "assigned"],
    page: 2,
    archived: false,
    "#": "issue-1",
  });
  expect(
    normalizeRouteHistoryHref(href, ["h", "[serverId]", "plugin", "[pluginId]", "[surfaceId]"]),
  ).toBe("/h/host/plugin/example/main?archived=false&filter=open&filter=assigned&page=2#issue-1");
});

it("supports native routes without params", () => {
  expect(buildNativeRouteHistoryHref("/settings/general", undefined)).toBe("/settings/general");
});

it("retains query and nested fragment state without the browser URL implementation", () => {
  vi.stubGlobal("URL", undefined);
  try {
    const href = buildNativeRouteHistoryHref("/settings/hosts/host", {
      tab: "providers",
      "#": "provider/details",
    });
    expect(normalizeRouteHistoryHref(href, ["settings", "hosts", "[hostId]"])).toBe(
      "/settings/hosts/host?tab=providers#provider/details",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
