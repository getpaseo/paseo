import type { Page } from "@playwright/test";

declare global {
  var __PASEO_E2E_REACT_RENDERS__: Record<string, number> | undefined;
}

/**
 * Counts which components render in each React commit, by name, the way React DevTools
 * highlights updates: a fiber rendered when React performed work on it in that commit.
 * Install before the app loads; React registers with the DevTools hook at startup.
 */
export async function recordReactRenders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const PERFORMED_WORK = 1;
    interface Fiber {
      type: unknown;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
    }
    const nameOf = (type: unknown): string | null => {
      if (typeof type === "function") {
        return (type as { displayName?: string }).displayName || type.name || null;
      }
      if (!type || typeof type !== "object") return null;
      const component = type as { displayName?: string; render?: unknown; type?: unknown };
      return component.displayName || nameOf(component.render) || nameOf(component.type);
    };
    const record = (root: Fiber) => {
      const renders = (globalThis.__PASEO_E2E_REACT_RENDERS__ ??= {});
      const pending: Fiber[] = [root];
      while (pending.length > 0) {
        const fiber = pending.pop()!;
        const name = typeof fiber.type === "string" ? null : nameOf(fiber.type);
        if (name && (fiber.flags & PERFORMED_WORK) !== 0) renders[name] = (renders[name] ?? 0) + 1;
        // A subtree React bailed out of is shared with the previous commit; skip it.
        if (fiber.alternate && fiber.child === fiber.alternate.child) continue;
        for (let child = fiber.child; child; child = child.sibling) pending.push(child);
      }
    };
    let rendererCount = 0;
    Object.defineProperty(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      configurable: true,
      value: {
        supportsFiber: true,
        isDisabled: false,
        renderers: new Map(),
        inject(renderer: unknown) {
          rendererCount += 1;
          this.renderers.set(rendererCount, renderer);
          return rendererCount;
        },
        checkDCE() {},
        onScheduleFiberRoot() {},
        onCommitFiberRoot(_rendererId: number, root: { current: Fiber }) {
          record(root.current);
        },
        onPostCommitFiberRoot() {},
        onCommitFiberUnmount() {},
      },
    });
  });
}

export async function resetReactRenders(page: Page): Promise<void> {
  await page.evaluate(() => {
    globalThis.__PASEO_E2E_REACT_RENDERS__ = {};
  });
}

/** Render counts per component name since the last reset, read after the next painted frame. */
export async function readReactRenders(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { ...globalThis.__PASEO_E2E_REACT_RENDERS__ };
  });
}
