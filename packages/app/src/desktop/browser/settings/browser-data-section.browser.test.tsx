import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { BrowserDataSection } from "./browser-data-section";
import { en } from "@/i18n/resources/en";
import type { DesktopHostBridge } from "@/desktop/host";

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: vi.fn(), error: vi.fn() }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split(".")
        .reduce((value: unknown, segment) => (value as Record<string, unknown>)[segment], en),
  }),
}));
vi.mock("@/constants/platform", async (original) => ({
  ...(await original<object>()),
  getIsElectron: () => true,
}));
// Native keyframe cleanup is unavailable in the Unistyles browser fixture.
vi.mock("react-native-reanimated", async (original) => ({
  ...(await original<object>()),
  Keyframe: class {
    duration() {
      return undefined;
    }
  },
}));
let root: Root;
let container: HTMLDivElement;
const listProfiles = vi.fn();
const importProfile = vi.fn();
beforeEach(async () => {
  await page.viewport(900, 520);
  vi.stubGlobal("React", React);
  vi.stubGlobal("paseoDesktop", {
    platform: "darwin",
    browser: { listCometProfiles: listProfiles, importCometProfile: importProfile },
  } satisfies DesktopHostBridge);
  listProfiles.mockReset().mockResolvedValue([{ id: "opaque-profile", name: "Personal" }]);
  importProfile
    .mockReset()
    .mockResolvedValue({ status: "complete", imported: 2, skipped: 0, failed: 0 });
  container = document.createElement("div");
  container.style.cssText = "width:760px;padding:24px;background:#fff";
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<BrowserDataSection />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("imports the only profile and keeps a concise success visible", async () => {
  await page.getByRole("button", { name: "Import from Comet", exact: true }).click();
  await expect.element(page.getByText("Import complete", { exact: true })).toBeVisible();
  expect(importProfile).toHaveBeenCalledExactlyOnceWith({ profileId: "opaque-profile" });
  await page.screenshot({ path: "/tmp/paseo-browser-evidence/comet-import-success.png" });
});
it("shows pending progress and prevents duplicate submissions", async () => {
  let finish: (value: {
    status: "complete";
    imported: number;
    skipped: number;
    failed: number;
  }) => void = () => {
    throw new Error("Import not started");
  };
  importProfile.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await page.getByRole("button", { name: "Import from Comet", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Importing…", exact: true }))
    .toBeDisabled();
  expect(importProfile).toHaveBeenCalledTimes(1);
  finish({ status: "complete", imported: 2, skipped: 0, failed: 0 });
  await expect.element(page.getByText("Import complete", { exact: true })).toBeVisible();
});
it("keeps errors visible and lets the user retry", async () => {
  importProfile.mockRejectedValueOnce(
    new Error(
      "Error invoking remote method 'paseo:browser:import-comet-profile': Error: COMET_KEYCHAIN_UNAVAILABLE",
    ),
  );
  await page.getByRole("button", { name: "Import from Comet", exact: true }).click();
  await expect
    .element(page.getByText("Allow access to Comet in Keychain, then retry.", { exact: true }))
    .toBeVisible();
  await page.screenshot({ path: "/tmp/paseo-browser-evidence/comet-import-error.png" });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.element(page.getByText("Import complete", { exact: true })).toBeVisible();
});
it("offers a profile choice before importing and reports partial completion", async () => {
  listProfiles.mockResolvedValue([
    { id: "one", name: "Personal" },
    { id: "two", name: "Work" },
  ]);
  importProfile.mockResolvedValue({
    status: "partial",
    imported: 1,
    skipped: 0,
    failed: 1,
    reason: "Certaines connexions n’ont pas pu être importées.",
  });
  await page.getByRole("button", { name: "Import from Comet", exact: true }).click();
  expect(importProfile).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Comet profile: Personal", exact: true }).click();
  await page.getByText("Work", { exact: true }).click();
  await page.getByRole("button", { name: "Import from Comet", exact: true }).click();
  await expect.element(page.getByText("Partial import", { exact: true })).toBeVisible();
  expect(importProfile).toHaveBeenCalledExactlyOnceWith({ profileId: "two" });
});
it("shows a localized fallback for unexpected bridge errors", async () => {
  importProfile.mockRejectedValueOnce(new Error("Internal operation failed at /private/data"));
  await page.getByRole("button", { name: "Import from Comet", exact: true }).click();
  await expect.element(page.getByText("Import failed. Try again.", { exact: true })).toBeVisible();
});
