import { expect, test } from "vitest";
import { createHostPluginClientBundleStore } from "./index.web";

async function sha256(contents: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("browser bundles survive a fresh store and remain isolated by host", async () => {
  const first = createHostPluginClientBundleStore("bundle-test-host-a");
  const second = createHostPluginClientBundleStore("bundle-test-host-b");
  const clientBundle = "bundle".repeat(250_000);
  const entry = {
    id: "same-plugin",
    clientBundle,
    clientBundleHash: await sha256(clientBundle),
  };
  const otherCode = "other host code";
  const other = {
    id: entry.id,
    clientBundle: otherCode,
    clientBundleHash: await sha256(otherCode),
  };
  try {
    await first.replace([entry]);
    await second.replace([other]);
    expect(await createHostPluginClientBundleStore("bundle-test-host-a").load()).toEqual([entry]);
    expect(await createHostPluginClientBundleStore("bundle-test-host-b").load()).toEqual([other]);
    await first.replace([]);
    expect(await createHostPluginClientBundleStore("bundle-test-host-a").load()).toEqual([]);
    expect(await second.load()).toEqual([other]);
  } finally {
    await first.replace([]);
    await second.replace([]);
  }
});
