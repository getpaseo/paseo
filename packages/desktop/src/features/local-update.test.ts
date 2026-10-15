import { describe, expect, it } from "vitest";
import { LocalUpdatePolicy } from "./local-update-policy";

describe("local update activation", () => {
  it("waits for idle, counts down, cancels on interaction and supports postponing", () => {
    const policy = new LocalUpdatePolicy("old", 0);
    policy.installed("new");
    expect(policy.tick(59_999).phase).toBe("ready");
    expect(policy.tick(60_000)).toMatchObject({ phase: "countdown", deadline: 70_000 });
    policy.activity(65_000);
    expect(policy.tick(70_000).phase).toBe("ready");
    expect(policy.tick(125_000).phase).toBe("countdown");
    policy.postpone(126_000);
    expect(policy.tick(126_000 + 1_799_999).phase).toBe("ready");
    expect(policy.tick(126_000 + 1_800_000).phase).toBe("countdown");
  });
});

it("cancels activation when input arrives while drafts are flushing", () => {
  const policy = new LocalUpdatePolicy("old", 0);
  policy.installed("new");
  policy.tick(60_000);
  expect(policy.tick(70_000).phase).toBe("activating");
  policy.activity(70_001);
  expect(policy.tick(70_002).phase).toBe("ready");
});
it("does not retry a failed build on every poll", () => {
  const policy = new LocalUpdatePolicy("old", 0);
  policy.installed("new");
  policy.fail("failed");
  policy.installed("new");
  expect(policy.tick(1_000_000).phase).toBe("error");
});

it("publishes the postponement deadline so every window can hide the notice", () => {
  const policy = new LocalUpdatePolicy("old", 0);
  policy.installed("new");
  policy.postpone(100);
  expect(policy.tick(100)).toMatchObject({ phase: "ready", postponedUntil: 1_800_100 });
  expect(policy.tick(1_800_099).phase).toBe("ready");
  expect(policy.tick(1_800_100).phase).toBe("countdown");
});

for (const surface of ["app", "widget"] as const) {
  it(`${surface} closes notices across polls and hides postponed updates`, async () => {
    const { chromium } = await import("playwright");
    const { readFileSync, mkdirSync } = await import("node:fs");
    const { default: ts } = await import("typescript");
    const source = readFileSync(
      new URL(
        surface === "app"
          ? "../../../app/src/desktop/use-local-update.electron.ts"
          : "./agent-widget/preload.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 650, height: 180 } });
      await page.setContent('<div id="widget"></div>');
      // Electron IPC and the React lifecycle are the only substituted boundaries.
      await page.evaluate(
        ({ code: browserCode, surface: browserSurface }) => {
          const listeners = new Map<string, (...args: unknown[]) => void>();
          let postponements = 0;
          const emit = (value: unknown) =>
            browserSurface === "app"
              ? listeners.get("status")!(value)
              : listeners.get("paseo:local-update:status")!({}, value);
          const postpone = async () => {
            postponements++;
            emit({ phase: "ready", installed: "newer", postponedUntil: Date.now() + 1_800_000 });
          };
          const ipcRenderer = {
            on: (name: string, listener: (...args: unknown[]) => void) =>
              listeners.set(name, listener),
            invoke: async (name: string) => {
              if (name.endsWith(":postpone")) await postpone();
              return null;
            },
          };
          const bridge = {
            buildId: "old",
            ready: async () => {},
            activity: async () => {},
            postpone,
            onPrepare: () => () => {},
            onStatus: (listener: (...args: unknown[]) => void) => {
              listeners.set("status", listener);
              return () => {};
            },
          };
          const modules: Record<string, unknown> = {
            electron: { ipcRenderer },
            react: { useEffect: (effect: () => void) => effect() },
            "./host": { getDesktopHost: () => ({ localUpdate: bridge }) },
            "./use-local-update-blocker": { hasLocalUpdateBlockers: () => false },
            "@/stores/draft-store": { flushDraftPersistStorage: async () => {} },
          };
          const exports: { useLocalUpdate?: () => void } = {};
          new Function("require", "exports", "process", browserCode)(
            (name: string) => modules[name],
            exports,
            { env: { EXPO_PUBLIC_PASEO_BUILD_ID: "old" }, argv: ["--paseo-build-id=old"] },
          );
          if (browserSurface === "app") exports.useLocalUpdate!();
          else window.dispatchEvent(new Event("DOMContentLoaded"));
          Object.assign(window, { emitStatus: emit, postponements: () => postponements });
        },
        { code, surface },
      );
      const emit = (value: Record<string, unknown>) =>
        page.evaluate((state) => {
          (window as unknown as { emitStatus: (value: unknown) => void }).emitStatus(state);
        }, value);
      const ready = { phase: "ready", installed: "new" };
      await emit(ready);
      const close = page.getByRole("button", { name: "Fermer la notification" });
      expect(await close.count()).toBe(1);
      if (process.env.PASEO_NOTICE_SCREENSHOTS) {
        mkdirSync(process.env.PASEO_NOTICE_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: `${process.env.PASEO_NOTICE_SCREENSHOTS}/${surface}-notice.png`,
        });
      }
      await close.click();
      await emit(ready);
      expect(await page.getByRole("status").count()).toBe(0);
      expect(
        await page.evaluate(() =>
          (window as unknown as { postponements: () => number }).postponements(),
        ),
      ).toBe(0);
      await emit({ ...ready, phase: "countdown", deadline: Date.now() + 10_000 });
      await close.focus();
      await page.keyboard.press("Enter");
      await emit({ ...ready, phase: "countdown", deadline: Date.now() + 9_000 });
      expect(await page.getByRole("status").count()).toBe(0);
      await emit(ready);
      expect(await page.getByRole("status").count()).toBe(0);
      await emit({ phase: "ready", installed: "newer" });
      await page.getByRole("button", { name: "Reporter 30 min" }).click();
      expect(await page.getByRole("status").count()).toBe(0);
      expect(
        await page.evaluate(() =>
          (window as unknown as { postponements: () => number }).postponements(),
        ),
      ).toBe(1);
      await emit({ phase: "ready", installed: "newer", postponedUntil: Date.now() - 1 });
      expect(await close.count()).toBe(1);
      await emit({ ...ready, phase: "error", error: "Échec de la mise à jour" });
      expect(await page.getByRole("status").textContent()).toContain("Échec de la mise à jour");
      await close.click();
      await emit({ ...ready, phase: "error", error: "Échec de la mise à jour" });
      expect(await page.getByRole("status").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });
}
