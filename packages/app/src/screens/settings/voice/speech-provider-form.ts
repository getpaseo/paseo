import type { SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import {
  SPEECH_SITE_KIND,
  buildSpeechSitePatch,
  resolveOpenAiModel,
  resolveOpenAiVoice,
  speechSiteFieldPath,
  type SpeechModelKind,
  type SpeechProvider,
  type SpeechSite,
  type SpeechSiteId,
  type SpeechSitePatch,
} from "./voice-settings";

// The provider sheet's form: one speech site, its provider and that provider's fields.
// Plain TypeScript so the save rules are testable without rendering (docs/forms.md).

export interface SpeechProviderFormSnapshot {
  siteId: SpeechSiteId;
  site: Extract<SpeechSite, { provider: SpeechProvider }>;
  envOverrides: Record<string, string>;
}

export type SpeechProviderField =
  | "provider"
  | "model"
  | "apiKey"
  | "baseUrl"
  | "language"
  | "voice";

// An env var set for one of these is only a fallback: a value saved in the sheet wins,
// so the field stays editable. Every other field is decided by its env var.
const FALLBACK_FIELDS: ReadonlySet<SpeechProviderField> = new Set(["apiKey", "baseUrl"]);

export interface SpeechProviderFieldSource {
  /** The env var that decides this field's effective value, when one does. */
  envVar: string | null;
  readOnly: boolean;
}

export interface SpeechProviderFormState {
  kind: SpeechModelKind;
  provider: SpeechProvider;
  /** The local model the user picked in this sheet; null keeps the saved or default model. */
  localModel: string | null;
  savedLocalModel: string | undefined;
  apiKey: string;
  hasSavedApiKey: boolean;
  baseUrl: string;
  openAiModel: string;
  language: string;
  voice: string;
  fields: Record<SpeechProviderField, SpeechProviderFieldSource>;
  saving: boolean;
  canSave: boolean;
}

export type SpeechProviderSaveResult =
  | { status: "saved" }
  | { status: "skipped" }
  | { status: "failed"; error: unknown };

export interface SpeechProviderFormModel {
  getState: () => SpeechProviderFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setProvider: (provider: SpeechProvider) => void;
  setLocalModel: (modelId: string) => void;
  setApiKey: (value: string) => void;
  setBaseUrl: (value: string) => void;
  setOpenAiModel: (value: string) => void;
  setLanguage: (value: string) => void;
  setVoice: (value: string) => void;
  /** Sends the changed fields through `save`; the inputs survive a failed save. */
  save: (
    save: (patch: SpeechSettingsPatch) => Promise<unknown>,
  ) => Promise<SpeechProviderSaveResult>;
}

interface OpenAiValues {
  baseUrl: string;
  openAiModel: string;
  voice: string;
}

export function openSpeechProviderForm(
  snapshot: SpeechProviderFormSnapshot,
): SpeechProviderFormModel {
  const { siteId, site, envOverrides } = snapshot;
  const kind = SPEECH_SITE_KIND[siteId];
  const savedOpenAi = site.provider === "openai" ? site : undefined;
  const initialOpenAi: OpenAiValues = {
    baseUrl: savedOpenAi?.baseUrl ?? "",
    openAiModel: resolveOpenAiModel(kind, savedOpenAi?.model),
    voice: resolveOpenAiVoice(savedOpenAi?.voice),
  };
  const initialLanguage = site.language ?? "";
  // The daemon reports env vars for the provider that is in effect, so they only describe the
  // provider-specific fields while that provider is selected. Language applies to either STT provider.
  const savedFields = buildFieldSources(siteId, envOverrides);
  const switchedFields = {
    ...buildFieldSources(siteId, {}),
    provider: savedFields.provider,
    language: savedFields.language,
  };
  const listeners = new Set<() => void>();
  let closed = false;

  let state: SpeechProviderFormState = derive({
    kind,
    provider: site.provider,
    localModel: null,
    savedLocalModel: site.provider === "local" ? site.model : undefined,
    apiKey: "",
    hasSavedApiKey: savedOpenAi?.hasApiKey ?? false,
    ...initialOpenAi,
    language: initialLanguage,
    fields: savedFields,
    saving: false,
    canSave: false,
  });

  function derive(next: SpeechProviderFormState): SpeechProviderFormState {
    return {
      ...next,
      fields: next.provider === site.provider ? savedFields : switchedFields,
      canSave: !next.saving && isChanged(next),
    };
  }

  function isChanged(next: SpeechProviderFormState): boolean {
    if (next.provider !== site.provider) return true;
    if (kind === "stt" && next.language.trim() !== initialLanguage) return true;
    if (next.provider === "local") {
      return next.localModel !== null && next.localModel !== next.savedLocalModel;
    }
    return next.apiKey.trim().length > 0 || changedOpenAiFields(next).length > 0;
  }

  function changedOpenAiFields(next: SpeechProviderFormState): (keyof OpenAiValues)[] {
    const keys: (keyof OpenAiValues)[] =
      kind === "stt" ? ["baseUrl", "openAiModel"] : ["baseUrl", "openAiModel", "voice"];
    return keys.filter((key) => next[key].trim() !== initialOpenAi[key]);
  }

  function buildSitePatch(next: SpeechProviderFormState): SpeechSitePatch {
    const language = next.language.trim();
    const languagePatch: Record<string, string | null> =
      kind === "stt" &&
      !next.fields.language.readOnly &&
      (language !== initialLanguage || (next.provider !== site.provider && language.length > 0))
        ? { language: language || null }
        : {};
    if (next.provider === "local") {
      return {
        provider: "local",
        ...languagePatch,
        ...(next.localModel !== null && !next.fields.model.readOnly
          ? { model: next.localModel }
          : {}),
      };
    }
    const patch: Record<string, string | null> = { provider: "openai", ...languagePatch };
    const apiKey = next.apiKey.trim();
    if (apiKey) patch.apiKey = apiKey;
    for (const key of changedOpenAiFields(next)) {
      const field = key === "openAiModel" ? "model" : key;
      if (next.fields[field].readOnly) continue;
      patch[field] = next[key].trim() || null;
    }
    return patch as SpeechSitePatch;
  }

  function publish(next: SpeechProviderFormState): void {
    if (closed) return;
    state = derive(next);
    for (const listener of listeners) listener();
  }

  function edit(change: Partial<SpeechProviderFormState>): void {
    if (state.saving) return;
    publish({ ...state, ...change });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    setProvider: (provider) => {
      if (!state.fields.provider.readOnly) edit({ provider });
    },
    setLocalModel: (localModel) => {
      if (!state.fields.model.readOnly) edit({ localModel });
    },
    setApiKey: (apiKey) => edit({ apiKey }),
    setBaseUrl: (baseUrl) => edit({ baseUrl }),
    setOpenAiModel: (openAiModel) => edit({ openAiModel }),
    setLanguage: (language) => edit({ language }),
    setVoice: (voice) => edit({ voice }),
    async save(save) {
      if (!state.canSave) return { status: "skipped" };
      const patch = buildSpeechSitePatch(siteId, buildSitePatch(state));
      publish({ ...state, saving: true });
      try {
        await save(patch);
        return { status: "saved" };
      } catch (error) {
        publish({ ...state, saving: false });
        return { status: "failed", error };
      }
    },
  };
}

function buildFieldSources(
  siteId: SpeechSiteId,
  envOverrides: Record<string, string>,
): Record<SpeechProviderField, SpeechProviderFieldSource> {
  const source = (field: SpeechProviderField): SpeechProviderFieldSource => {
    const envVar = envOverrides[speechSiteFieldPath(siteId, field)] ?? null;
    return { envVar, readOnly: envVar !== null && !FALLBACK_FIELDS.has(field) };
  };
  return {
    provider: source("provider"),
    model: source("model"),
    apiKey: source("apiKey"),
    baseUrl: source("baseUrl"),
    language: source("language"),
    voice: source("voice"),
  };
}
