import type { LocalSpeechModel, SpeechSettings } from "@getpaseo/protocol/speech/rpc-schemas";

// What the Voice page needs to know about speech providers and models, kept free of React
// so the option lists and model states are testable on their own.

export type SpeechProvider = "local" | "openai";
export type SpeechModelKind = "stt" | "tts";

export const SPEECH_PROVIDERS: readonly SpeechProvider[] = ["local", "openai"];

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

export function toSpeechProvider(provider: string): SpeechProvider {
  return provider === "openai" ? "openai" : "local";
}

export function resolveSelectedModel(input: {
  kind: SpeechModelKind;
  provider: SpeechProvider;
  model: string | undefined;
  localModels: readonly LocalSpeechModel[];
}): string {
  if (input.model) return input.model;
  if (input.provider === "openai") return OPENAI_MODELS[input.kind].defaultId;
  return input.localModels.find((m) => m.kind === input.kind && m.isDefault)?.id ?? "";
}

export function buildModelOptions(input: {
  kind: SpeechModelKind;
  provider: SpeechProvider;
  selected: string;
  localModels: readonly LocalSpeechModel[];
  notDownloadedLabel: (label: string) => string;
}): SpeechModelOption[] {
  if (input.provider === "openai") {
    return withSelected(
      OPENAI_MODELS[input.kind].ids.map((id) => ({ value: id, label: id })),
      input.selected,
    );
  }
  return input.localModels
    .filter((model) => model.kind === input.kind)
    .map((model) => ({
      value: model.id,
      label: model.status === "installed" ? model.label : input.notDownloadedLabel(model.label),
    }));
}

export function resolveSelectedVoice(voice: string | undefined): string {
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

export function usesOpenAi(settings: SpeechSettings): boolean {
  return (
    (settings.dictation.enabled && settings.dictation.stt.provider === "openai") ||
    (settings.voiceMode.enabled &&
      (settings.voiceMode.stt.provider === "openai" ||
        settings.voiceMode.tts.provider === "openai"))
  );
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

// What a collapsed local provider row says: an active download wins over the count.
export type LocalModelsSummary =
  | { kind: "downloading"; percent: number | null }
  | { kind: "extracting" }
  | { kind: "downloaded"; count: number };

export function summarizeLocalModels(
  models: readonly LocalSpeechModel[],
  kind: SpeechModelKind,
): LocalModelsSummary {
  const kindModels = models.filter((model) => model.kind === kind);
  const busy = kindModels.find(isLocalModelBusy);
  if (busy) {
    const state = getLocalModelState(busy);
    if (state.kind === "downloading") return state;
    return { kind: "extracting" };
  }
  return {
    kind: "downloaded",
    count: kindModels.filter((model) => model.status === "installed").length,
  };
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
