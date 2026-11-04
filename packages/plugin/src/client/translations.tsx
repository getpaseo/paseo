import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createInstance, type i18n } from "i18next";
import type {
  PluginMessage,
  PluginText,
  PluginTranslations,
  TranslationKey,
  TranslationArguments,
  TranslationResource,
  TranslationOptions,
} from "../text.js";

type Resources = PluginTranslations["resources"];
interface MessageDefinition {
  resources: Resources;
  key: string;
  options?: TranslationOptions;
}
const messageDefinitions = new WeakMap<PluginMessage, MessageDefinition>();

export function defineTranslations<const Resource extends TranslationResource>(definition: {
  resources: Readonly<Record<string, TranslationResource>> & { en: Resource };
}): PluginTranslations<Resource> {
  const english = validateResources(definition.resources);
  return {
    resources: definition.resources,
    message: (key, ...args) => {
      const source = english.get(key) ?? english.get(`${key}_other`);
      if (source === undefined) throw new Error(`Unknown translation key: ${key}`);
      const options = args[0];
      for (const name of placeholders(source)) {
        if (options?.[name] === undefined)
          throw new Error(`Missing translation value: ${name} (${key})`);
      }
      const message = Object.freeze({}) as PluginMessage;
      messageDefinitions.set(message, { resources: definition.resources, key, options });
      return message;
    },
  };
}

/** App language source. Each installation subscribes for exactly its own lifetime. */
export interface PluginLocaleSource {
  getLocale(): string;
  subscribe(listener: () => void): () => void;
}

export interface PluginI18n {
  readonly locale: string;
  t<Resource extends TranslationResource, Key extends TranslationKey<Resource>>(
    messages: PluginTranslations<Resource>,
    key: Key,
    ...args: TranslationArguments<Resource, Key>
  ): string;
}

export class PluginTranslationRuntime implements PluginI18n {
  private readonly engines = new Map<Resources, i18n>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private stopped = false;
  constructor(private readonly source: PluginLocaleSource) {
    this.unsubscribe = source.subscribe(() => {
      for (const listener of this.listeners) listener();
    });
  }
  get locale(): string {
    return this.source.getLocale();
  }
  getSnapshot = (): string => this.locale;
  subscribe = (listener: () => void): (() => void) => {
    if (this.stopped) throw new Error("Plugin translations have stopped");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  t<Resource extends TranslationResource, Key extends TranslationKey<Resource>>(
    messages: PluginTranslations<Resource>,
    key: Key,
    ...args: TranslationArguments<Resource, Key>
  ): string {
    return this.resolve(messages.message(key, ...args));
  }
  resolve = (text: PluginText, locale = this.locale): string => {
    if (typeof text === "string") return text;
    if (this.stopped) throw new Error("Plugin translations have stopped");
    const message = messageDefinitions.get(text);
    if (!message) throw new Error("Plugin labels must use messages.message()");
    let engine = this.engines.get(message.resources);
    if (!engine) {
      engine = createInstance();
      void engine.init({
        initAsync: false,
        lng: this.locale,
        fallbackLng: "en",
        resources: Object.fromEntries(
          Object.entries(message.resources).map(([language, translation]) => [
            language,
            { translation },
          ]),
        ),
        interpolation: { escapeValue: false },
        returnNull: false,
        returnObjects: false,
      });
      this.engines.set(message.resources, engine);
    }
    return engine.t(message.key, { ...message.options, lng: locale });
  };
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    this.listeners.clear();
    this.engines.clear();
  }
}

export function isPluginMessage(value: unknown): value is PluginMessage {
  return (
    typeof value === "object" && value !== null && messageDefinitions.has(value as PluginMessage)
  );
}
export function requirePluginText(text: unknown): PluginText {
  if (typeof text === "string" && text.trim()) return text.trim();
  if (isPluginMessage(text)) return text;
  throw new Error("Plugin label must be a non-empty string or a translation message");
}

function flatten(resource: TranslationResource, prefix = ""): Map<string, string> {
  if (!resource || typeof resource !== "object" || Array.isArray(resource))
    throw new Error("Translation resources must be objects of strings");
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(resource)) {
    if (!key || key.includes(".") || ["__proto__", "constructor", "prototype"].includes(key))
      throw new Error(`Invalid translation key: ${key}`);
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") result.set(path, value);
    else for (const entry of flatten(value, path)) result.set(...entry);
  }
  return result;
}
function pluralBase(key: string): string {
  return key.replace(/_(zero|one|two|few|many|other)$/, "");
}
function placeholders(value: string): string[] {
  return [
    ...new Set([...value.matchAll(/{{-?\s*([^},\s]+)(?:[^}]*)}}/g)].map((match) => match[1])),
  ].sort();
}
function validateResources(resources: Resources): Map<string, string> {
  const english = flatten(resources.en);
  if (!english.size) throw new Error("Plugin translations require English messages");
  for (const [locale, resource] of Object.entries(resources)) {
    if (Intl.getCanonicalLocales(locale)[0] !== locale)
      throw new Error(`Translation locale must be canonical: ${locale}`);
    for (const [key, value] of flatten(resource)) {
      const source = english.get(key) ?? english.get(`${pluralBase(key)}_other`);
      if (source === undefined) throw new Error(`Unknown translation key in ${locale}: ${key}`);
      if (placeholders(value).join(",") !== placeholders(source).join(","))
        throw new Error(`Translation placeholders differ in ${locale}: ${key}`);
    }
  }
  return english;
}

const Context = createContext<PluginTranslationRuntime | null>(null);
export function PluginTranslationProvider({
  runtime,
  children,
}: {
  runtime: PluginTranslationRuntime;
  children: ReactNode;
}) {
  return <Context.Provider value={runtime}>{children}</Context.Provider>;
}
export function usePluginTranslationRuntime(): PluginTranslationRuntime {
  const runtime = useContext(Context);
  if (!runtime) throw new Error("Plugin translations must run inside a contributed plugin surface");
  return runtime;
}
export function useTranslation<Resource extends TranslationResource>(
  messages: PluginTranslations<Resource>,
) {
  const runtime = usePluginTranslationRuntime();
  const locale = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const t = useCallback(
    <Key extends TranslationKey<Resource>>(
      key: Key,
      ...args: TranslationArguments<Resource, Key>
    ) => runtime.resolve(messages.message(key, ...args), locale),
    [runtime, messages, locale],
  );
  return { locale, t };
}
