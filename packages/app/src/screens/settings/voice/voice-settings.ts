import type {
  LocalSpeechModel,
  SpeechSettings,
  SpeechSettingsPatch,
} from "@getpaseo/protocol/speech/rpc-schemas";

// What the Voice page needs to know about speech providers and models, kept free of React
// so the option lists and model states are testable on their own.

export type SpeechProvider = "local" | "openai";
export type SpeechModelKind = "stt" | "tts";

export const SPEECH_PROVIDERS: readonly SpeechProvider[] = ["local", "openai"];

// The three places that use speech. Each carries its own provider settings in config.json
// under `features.<site>`.
export type SpeechSiteId = "dictation.stt" | "voiceMode.stt" | "voiceMode.tts";

export const SPEECH_SITE_KIND: Record<SpeechSiteId, SpeechModelKind> = {
  "dictation.stt": "stt",
  "voiceMode.stt": "stt",
  "voiceMode.tts": "tts",
};

/** The config path the daemon names in `envOverrides` for a field of a site. */
export function speechSiteFieldPath(siteId: SpeechSiteId, field: string): string {
  return `features.${siteId}.${field}`;
}

/** One site's settings as the daemon reports them, narrowed to what the app can edit. */
export type SpeechSite =
  | { provider: "local"; model?: string; language?: string }
  | {
      provider: "openai";
      hasApiKey: boolean;
      baseUrl?: string;
      model?: string;
      language?: string;
      voice?: string;
    }
  | { provider: "unknown"; id: string };

type SpeechSiteSettings = SpeechSettings["dictation"]["stt"] | SpeechSettings["voiceMode"]["tts"];

export function getSpeechSite(features: SpeechSettings, siteId: SpeechSiteId): SpeechSite {
  switch (siteId) {
    case "dictation.stt":
      return toSpeechSite(features.dictation.stt);
    case "voiceMode.stt":
      return toSpeechSite(features.voiceMode.stt);
    case "voiceMode.tts":
      return toSpeechSite(features.voiceMode.tts);
  }
}

function toSpeechSite(settings: SpeechSiteSettings): SpeechSite {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  if (settings.provider === "local")
    return { provider: "local", model: text(settings.model), language: text(settings.language) };
  if (settings.provider === "openai") {
    return {
      provider: "openai",
      hasApiKey: settings.hasApiKey === true,
      baseUrl: text(settings.baseUrl),
      model: text(settings.model),
      language: text(settings.language),
      voice: text(settings.voice),
    };
  }
  return { provider: "unknown", id: settings.provider };
}

export type SpeechSitePatch = NonNullable<
  | NonNullable<SpeechSettingsPatch["voiceMode"]>["stt"]
  | NonNullable<SpeechSettingsPatch["voiceMode"]>["tts"]
>;

export function buildSpeechSitePatch(
  siteId: SpeechSiteId,
  patch: SpeechSitePatch,
): SpeechSettingsPatch {
  switch (siteId) {
    case "dictation.stt":
      return { dictation: { stt: patch } };
    case "voiceMode.stt":
      return { voiceMode: { stt: patch } };
    case "voiceMode.tts":
      return { voiceMode: { tts: patch } };
  }
}

// OpenAI accepts free-form ids so self-hosted servers can use their own; these are the
// ones the page offers. A saved id outside the list is still shown as an option.
const OPENAI_MODELS: Record<SpeechModelKind, { ids: readonly string[]; defaultId: string }> = {
  stt: {
    ids: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
    defaultId: "whisper-1",
  },
  tts: { ids: ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"], defaultId: "tts-1" },
};

const OPENAI_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
const DEFAULT_OPENAI_VOICE = "alloy";

export interface SpeechModelOption {
  value: string;
  label: string;
}

export function resolveOpenAiModel(kind: SpeechModelKind, model: string | undefined): string {
  return model ?? OPENAI_MODELS[kind].defaultId;
}

export function resolveLocalModel(input: {
  kind: SpeechModelKind;
  model: string | undefined;
  localModels: readonly LocalSpeechModel[];
}): LocalSpeechModel | undefined {
  const kindModels = input.localModels.filter((model) => model.kind === input.kind);
  if (input.model) return kindModels.find((model) => model.id === input.model);
  return kindModels.find((model) => model.isDefault);
}

export function buildOpenAiModelOptions(
  kind: SpeechModelKind,
  selected: string,
): SpeechModelOption[] {
  return withSelected(
    OPENAI_MODELS[kind].ids.map((id) => ({ value: id, label: id })),
    selected,
  );
}

export function resolveOpenAiVoice(voice: string | undefined): string {
  return voice ?? DEFAULT_OPENAI_VOICE;
}

export function buildOpenAiVoiceOptions(selected: string): SpeechModelOption[] {
  return withSelected(
    OPENAI_VOICES.map((voice) => ({ value: voice, label: voice })),
    selected,
  );
}

function withSelected(options: SpeechModelOption[], selected: string): SpeechModelOption[] {
  if (!selected || options.some((option) => option.value === selected)) return options;
  return [...options, { value: selected, label: selected }];
}

// What a page row says about a site before it is opened.
export type SpeechSiteSummary =
  | { kind: "local"; model: string | null }
  | { kind: "openai"; model: string; missingKey: boolean }
  | { kind: "unknown"; provider: string };

export function summarizeSpeechSite(input: {
  siteId: SpeechSiteId;
  site: SpeechSite;
  envOverrides: Record<string, string>;
  localModels: readonly LocalSpeechModel[];
}): SpeechSiteSummary {
  const { site, siteId } = input;
  const kind = SPEECH_SITE_KIND[siteId];
  switch (site.provider) {
    case "local": {
      const model = resolveLocalModel({ kind, model: site.model, localModels: input.localModels });
      return { kind: "local", model: model?.label ?? site.model ?? null };
    }
    case "openai":
      return {
        kind: "openai",
        model: resolveOpenAiModel(kind, site.model),
        missingKey: !site.hasApiKey && !input.envOverrides[speechSiteFieldPath(siteId, "apiKey")],
      };
    case "unknown":
      return { kind: "unknown", provider: site.id };
  }
}

export type LocalModelState =
  | { kind: "installed" }
  | { kind: "not_installed" }
  | { kind: "downloading"; percent: number | null }
  | { kind: "extracting" }
  | { kind: "failed"; error: string };

export function getLocalModelState(model: LocalSpeechModel): LocalModelState {
  switch (model.status) {
    case "installed":
      return { kind: "installed" };
    case "downloading": {
      const total = model.totalBytes ?? 0;
      const received = model.receivedBytes ?? 0;
      return {
        kind: "downloading",
        percent: total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null,
      };
    }
    case "extracting":
      return { kind: "extracting" };
    case "failed":
      return { kind: "failed", error: model.error ?? "" };
    default:
      return { kind: "not_installed" };
  }
}

export function isLocalModelBusy(model: LocalSpeechModel): boolean {
  return model.status === "downloading" || model.status === "extracting";
}

export function formatModelSize(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  if (megabytes >= 1000) return `${(megabytes / 1000).toFixed(1)} GB`;
  return `${Math.round(megabytes)} MB`;
}

// Multilingual models list close to a hundred languages; past this many the tooltip names
// the first ones and counts the rest.
const MAX_LISTED_LANGUAGES = 10;

export function formatLanguages(input: {
  languages: readonly string[];
  locale: string;
  formatMore: (languages: string, count: number) => string;
}): string {
  const names = languageNames(input.locale);
  const listed = input.languages
    .slice(0, MAX_LISTED_LANGUAGES)
    .map((code) => names?.of(code) ?? code.toUpperCase())
    .join(", ");
  const hidden = input.languages.length - MAX_LISTED_LANGUAGES;
  return hidden > 0 ? input.formatMore(listed, hidden) : listed;
}

// Hermes ships without Intl.DisplayNames; the language code is the fallback label there.
function languageNames(locale: string): Intl.DisplayNames | null {
  if (typeof Intl.DisplayNames !== "function") return null;
  return new Intl.DisplayNames([locale], { type: "language" });
}
