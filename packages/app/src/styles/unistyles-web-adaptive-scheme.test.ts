// @vitest-environment jsdom
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UNISTYLES_WEB = path.resolve(
  __dirname,
  "../../../../node_modules/react-native-unistyles/lib/module",
);

type Scheme = "light" | "dark";
type ChangeListener = (event: { matches: boolean }) => void;

/**
 * Models how Chromium treats `MediaQueryList` on a hidden document: a scheme change
 * only marks lists as needing re-evaluation, reading `matches` re-evaluates that one
 * list silently, and the deferred change events fire when the document becomes
 * visible, only for lists whose cached value still differs.
 */
function installFakeMatchMedia() {
  let scheme: Scheme = "dark";
  let visible = true;
  const lists: FakeMediaQueryList[] = [];

  class FakeMediaQueryList {
    private cached: boolean;
    private listeners = new Set<ChangeListener>();

    constructor(readonly media: string) {
      this.cached = this.evaluate();
      lists.push(this);
    }

    get matches(): boolean {
      this.cached = this.evaluate();
      return this.cached;
    }

    addEventListener(type: string, listener: ChangeListener): void {
      if (type === "change") this.listeners.add(listener);
    }

    removeEventListener(type: string, listener: ChangeListener): void {
      if (type === "change") this.listeners.delete(listener);
    }

    settle(): void {
      const next = this.evaluate();
      if (next === this.cached) return;
      this.cached = next;
      for (const listener of this.listeners) listener({ matches: next });
    }

    private evaluate(): boolean {
      return this.media === `(prefers-color-scheme: ${scheme})`;
    }
  }

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => new FakeMediaQueryList(media),
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });

  return {
    hide: () => {
      visible = false;
    },
    setScheme: (next: Scheme) => {
      scheme = next;
      if (visible) for (const list of lists) list.settle();
    },
    show: () => {
      visible = true;
      for (const list of lists) list.settle();
    },
  };
}

describe("Unistyles web adaptive themes after the window was hidden", () => {
  let fake: ReturnType<typeof installFakeMatchMedia>;

  beforeEach(() => {
    vi.resetModules();
    fake = installFakeMatchMedia();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("emits the theme change when the scheme flipped while hidden and the theme was read before the window returned", async () => {
    const { services } = await import(path.join(UNISTYLES_WEB, "web/services.js"));
    const { UnistyleDependency } = await import(
      path.join(UNISTYLES_WEB, "specs/NativePlatform/NativePlatform.nitro.js")
    );
    services.state.init({
      themes: { light: { colors: { fg: "#111" } }, dark: { colors: { fg: "#eee" } } },
      settings: { adaptiveThemes: true },
    });
    const themeChanged = vi.fn();
    services.listener.addListeners([UnistyleDependency.Theme], themeChanged);
    expect(services.runtime.themeName).toBe("dark");

    fake.hide();
    fake.setScheme("light");
    // Any themed component mounting or re-rendering while the window is hidden asks
    // the runtime which theme is active.
    expect(services.runtime.themeName).toBe("light");
    fake.show();

    expect(themeChanged).toHaveBeenCalled();
    expect(services.runtime.themeName).toBe("light");
  });
});
