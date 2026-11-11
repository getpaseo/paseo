import { expect, it } from "vitest";
import { defineTranslations, PluginTranslationRuntime } from "./translations.js";

function language(initial = "en") {
  let locale = initial;
  const listeners = new Set<() => void>();
  return {
    getLocale: () => locale,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: string) {
      locale = next;
      for (const listener of listeners) listener();
    },
    subscriptions: () => listeners.size,
  };
}
const messages = defineTranslations({
  resources: {
    en: {
      screen: {
        title: "Notes",
        fallback: "English fallback",
        notes_one: "{{count}} note for {{name}}",
        notes_other: "{{count}} notes for {{name}}",
      },
    },
    "zh-CN": { screen: { title: "笔记", notes_other: "{{name}}的 {{count}} 条笔记" } },
  },
});
it("resolves messages, interpolation, plurals and English fallback with the current app locale", () => {
  const source = language();
  const runtime = new PluginTranslationRuntime(source);
  const title = messages.message("screen.title");
  expect(runtime.resolve(title)).toBe("Notes");
  expect(runtime.t(messages, "screen.notes", { count: 1, name: "Ada" })).toBe("1 note for Ada");
  expect(runtime.t(messages, "screen.notes", { count: 2, name: "Ada" })).toBe("2 notes for Ada");
  source.set("zh-CN");
  expect(runtime.resolve(title)).toBe("笔记");
  expect(runtime.t(messages, "screen.notes", { count: 2, name: "Ada" })).toBe("Ada的 2 条笔记");
  expect(runtime.t(messages, "screen.fallback")).toBe("English fallback");
  expect(runtime.locale).toBe("zh-CN");
  source.set("fr");
  expect(runtime.resolve(title)).toBe("Notes");
  expect(runtime.locale).toBe("fr");
  runtime.dispose();
});
it("isolates installations, resources and clients, and unsubscribes on unload", () => {
  const first = language("zh-CN");
  const second = language();
  const a = new PluginTranslationRuntime(first);
  const b = new PluginTranslationRuntime(second);
  const other = defineTranslations({ resources: { en: { screen: { title: "Other plugin" } } } });
  expect(a.t(messages, "screen.title")).toBe("笔记");
  expect(b.t(messages, "screen.title")).toBe("Notes");
  expect(a.t(other, "screen.title")).toBe("Other plugin");
  let updates = 0;
  a.subscribe(() => updates++);
  first.set("en");
  expect(updates).toBe(1);
  expect(first.subscriptions()).toBe(1);
  a.dispose();
  a.dispose();
  expect(first.subscriptions()).toBe(0);
  first.set("zh-CN");
  expect(updates).toBe(1);
  expect(b.t(messages, "screen.title")).toBe("Notes");
  b.dispose();
});

it("rejects unknown keys, malformed resources, noncanonical locales and placeholder drift", () => {
  expect(() =>
    defineTranslations({ resources: { en: { title: "Notes" }, fr: { typo: "Notes" } } }),
  ).toThrow("Unknown translation key");
  expect(() =>
    defineTranslations({ resources: { en: { title: "Notes" }, "zh-cn": { title: "笔记" } } }),
  ).toThrow("canonical");
  expect(() =>
    defineTranslations({
      resources: { en: { title: "Hello {{name}}" }, fr: { title: "Bonjour {{other}}" } },
    }),
  ).toThrow("placeholders differ");
  expect(() => defineTranslations({ resources: { en: {} } })).toThrow("English messages");
  expect(() => defineTranslations({ resources: { en: { value: 42 } } } as never)).toThrow(
    "objects of strings",
  );
});

it("uses Intl formatting and reports missing JSON interpolation values", () => {
  const source = language("en");
  const runtime = new PluginTranslationRuntime(source);
  const en: { amount: string; welcome: string } = {
    amount: "{{value, number}}",
    welcome: "Hello {{name}}",
  };
  const formatted = defineTranslations({ resources: { en } });
  expect(runtime.t(formatted, "amount", { value: 1234.5 })).toBe("1,234.5");
  expect(() => runtime.t(formatted, "welcome")).toThrow("Missing translation value: name");
  runtime.dispose();
});
