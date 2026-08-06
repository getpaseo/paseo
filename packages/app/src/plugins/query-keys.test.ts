import { describe, expect, it } from "vitest";
import { pluginEntryQueryKey, pluginRegistryQueryKey, pluginsQueryKey } from "./query-keys";

/** React Query invalidates by prefix, so the key shapes *are* the caching rules. */
function isPrefixOf(prefix: readonly string[], key: readonly string[]): boolean {
  return prefix.every((segment, index) => key[index] === segment);
}

describe("plugin query keys", () => {
  const SERVER = "srv-1";

  it("puts entry HTML under the installed-list key so one invalidation drops both", () => {
    expect(
      isPrefixOf(pluginsQueryKey(SERVER), pluginEntryQueryKey(SERVER, "csv-table", "preview.html")),
    ).toBe(true);
  });

  it("keeps the registry off that prefix so toggling a plugin does not re-download it", () => {
    expect(isPrefixOf(pluginsQueryKey(SERVER), pluginRegistryQueryKey(SERVER))).toBe(false);
  });

  it("does not collide across servers", () => {
    expect(pluginsQueryKey("a")).not.toEqual(pluginsQueryKey("b"));
    expect(pluginsQueryKey(null)).toEqual(pluginsQueryKey(""));
  });
});
