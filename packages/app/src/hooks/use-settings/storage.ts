import { isSyntaxThemeId, type SyntaxThemeId } from "@getpaseo/highlight";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type { QueryClient } from "@tanstack/react-query";
import type { DesktopSettings } from "@/desktop/settings/desktop-settings";
import type { AppLanguage } from "@/i18n/locales";
import type { SidebarNavPreference } from "@/sidebar-nav/model";
import {
  DEFAULT_SIDEBAR_CHECKS_DISPLAY,
  type SidebarChecksDisplay,
} from "@/components/sidebar/display-preferences/checks-display";
import {
  DEFAULT_SIDEBAR_ROW_ITEMS,
  isChecksHiddenByLegacyRowItem,
  type SidebarRowItems,
} from "@/components/sidebar/display-preferences/row-items";
import { isNative } from "@/constants/platform";
import {
  FONT_SIZE,
  PLUGIN_THEME_PREFERENCE,
  THEME_OPTIONS,
  type ThemePreference,
} from "@/styles/theme";
import { z } from "zod";
import { APP_SETTINGS_KEY, LEGACY_SETTINGS_KEY } from "./keys";
import { migrateAppSettings } from "./migrations";

export { APP_SETTINGS_KEY } from "./keys";
export const APP_SETTINGS_QUERY_KEY = ["app-settings"];

export type SendBehavior = ActiveTurnBehavior | "queue";
export type ReleaseChannel = "stable" | "beta";
export type ServiceUrlBehavior = "ask" | "in-app" | "external";
export type WorkspaceTitleSource = "title" | "branch";
export type PullRequestOpenLocation = "main" | "side" | "explorer";
/** What a sidebar workspace row shows in the space to the right of its title. */
export type SidebarWorkspaceTrailing = "diff" | "timestamp" | "none";
export type ToolCallDetailLevel = "overview" | "detailed";

const ThemePreferenceSchema = z.enum([
  ...THEME_OPTIONS.map((option) => option.name),
  PLUGIN_THEME_PREFERENCE,
]);
/** Where the theme picker lands when the persisted preference cannot be honoured. */
export const DEFAULT_THEME_PREFERENCE = "auto" satisfies ThemePreference;
export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 10_000;
export const MIN_TERMINAL_SCROLLBACK_LINES = 0;
export const MAX_TERMINAL_SCROLLBACK_LINES = 1_000_000;
export function defaultUiBaseFontSize(native: boolean): number {
  return native ? 15 : FONT_SIZE.base;
}

export const DEFAULT_UI_BASE_FONT_SIZE = defaultUiBaseFontSize(isNative);
export const MIN_UI_BASE_FONT_SIZE = 10;
export const MAX_UI_BASE_FONT_SIZE = 21;
export function defaultContentFontSize(native: boolean): number {
  return native ? 16 : FONT_SIZE.content;
}

export const DEFAULT_CONTENT_FONT_SIZE = defaultContentFontSize(isNative);
export const MIN_CONTENT_FONT_SIZE = 10;
export const MAX_CONTENT_FONT_SIZE = 21;
export const DEFAULT_CODE_FONT_SIZE = 12; // == FONT_SIZE.code
export const MIN_CODE_FONT_SIZE = 9;
export const MAX_CODE_FONT_SIZE = 22; // line-height 1.5×22=33 stays safe
export const MAX_FONT_FAMILY_LENGTH = 200;

export interface AppSettings {
  theme: ThemePreference;
  /** Which contributed theme `theme: "plugin"` selects. */
  pluginThemeId: string | null;
  language: AppLanguage;
  sendBehavior: SendBehavior;
  serviceUrlBehavior: ServiceUrlBehavior;
  terminalScrollbackLines: number;
  useLegacyTerminalRenderer: boolean;
  uiFontFamily: string; // "" = platform default UI stack
  monoFontFamily: string; // "" = platform default mono stack
  uiBaseFontSize: number; // clamped px, platform default 14 or 15
  contentFontSize: number; // clamped px, platform default 15 or 16
  codeFontSize: number; // clamped px, default 12
  syntaxTheme: SyntaxThemeId; // default "one"
  workspaceTitleSource: WorkspaceTitleSource;
  sidebarWorkspaceTrailing: SidebarWorkspaceTrailing;
  sidebarRowItems: SidebarRowItems;
  sidebarChecksDisplay: SidebarChecksDisplay;
  /** Top-level sidebar rows in display order; empty means the default order, all visible. */
  sidebarNavItems: SidebarNavPreference[];
  autoExpandReasoning: boolean;
  toolCallDetailLevel: ToolCallDetailLevel;
  chatOutlineEnabled: boolean;
  vimKeybindings: boolean;
  /** Desktop-only preferences for implicit opens into the ordinary side pane. */
  openInSidePane: OpenInSidePanePreferences;
  pullRequestOpenLocation: PullRequestOpenLocation;
}

export type AppSettingsUpdate =
  | Partial<AppSettings>
  | ((current: AppSettings) => Partial<AppSettings>);

export interface OpenInSidePanePreferences {
  explorerFiles: boolean;
  diffs: boolean;
  chatFiles: boolean;
  diffFiles: boolean;
  subagents: boolean;
}

export const DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES: OpenInSidePanePreferences = {
  explorerFiles: false,
  diffs: false,
  chatFiles: false,
  diffFiles: false,
  subagents: false,
};

export interface Settings extends AppSettings {
  manageBuiltInDaemon: boolean;
  releaseChannel: ReleaseChannel;
}

export const DEFAULT_CLIENT_SETTINGS: AppSettings = {
  theme: DEFAULT_THEME_PREFERENCE,
  pluginThemeId: null,
  language: "system",
  sendBehavior: "steer",
  serviceUrlBehavior: "ask",
  terminalScrollbackLines: DEFAULT_TERMINAL_SCROLLBACK_LINES,
  useLegacyTerminalRenderer: false,
  uiFontFamily: "",
  monoFontFamily: "",
  uiBaseFontSize: DEFAULT_UI_BASE_FONT_SIZE,
  contentFontSize: DEFAULT_CONTENT_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  syntaxTheme: "one",
  workspaceTitleSource: "title",
  sidebarWorkspaceTrailing: "diff",
  sidebarRowItems: DEFAULT_SIDEBAR_ROW_ITEMS,
  sidebarChecksDisplay: DEFAULT_SIDEBAR_CHECKS_DISPLAY,
  sidebarNavItems: [],
  autoExpandReasoning: false,
  toolCallDetailLevel: "detailed",
  chatOutlineEnabled: true,
  vimKeybindings: false,
  openInSidePane: DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES,
  pullRequestOpenLocation: "explorer",
};

export const DEFAULT_APP_SETTINGS: Settings = {
  ...DEFAULT_CLIENT_SETTINGS,
  manageBuiltInDaemon: true,
  releaseChannel: "stable",
};

function clampedNumber(min: number, max: number) {
  return z
    .unknown()
    .transform((value) => parseClampedFontSize(value, { min, max }))
    .pipe(z.number());
}

function sanitizedFontFamily() {
  return z.unknown().transform(sanitizeFontFamily).pipe(z.string());
}

const SidebarRowItemsSchema = z
  .looseObject({
    branch: z.boolean().catch(DEFAULT_SIDEBAR_ROW_ITEMS.branch),
    project: z.boolean().catch(DEFAULT_SIDEBAR_ROW_ITEMS.project),
    host: z.boolean().catch(DEFAULT_SIDEBAR_ROW_ITEMS.host),
    changeRequest: z.boolean().catch(DEFAULT_SIDEBAR_ROW_ITEMS.changeRequest),
    services: z.boolean().optional().catch(undefined),
    labels: z.boolean().catch(DEFAULT_SIDEBAR_ROW_ITEMS.labels),
    // COMPAT(sidebarRowItemsChecks): migrated in v0.3.0, remove after 2027-08-05.
    checks: z.boolean().optional().catch(undefined),
    // COMPAT(sidebarRowItemsScripts): migrated in v0.3.0, remove after 2027-08-05.
    scripts: z.boolean().optional().catch(undefined),
  })
  .catch(DEFAULT_SIDEBAR_ROW_ITEMS);

type StoredAppSettingsFallback = AppSettings & {
  uiFontSize?: number;
  compactToolCalls?: boolean;
  manageBuiltInDaemon?: boolean;
  releaseChannel?: ReleaseChannel;
  needsWrite: boolean;
};

const DEFAULT_STORED_APP_SETTINGS = {
  ...DEFAULT_CLIENT_SETTINGS,
  needsWrite: false,
} satisfies StoredAppSettingsFallback;

const StoredAppSettingsSchema = z
  .looseObject({
    theme: ThemePreferenceSchema.catch(DEFAULT_THEME_PREFERENCE),
    pluginThemeId: z.string().nullable().catch(null),
    language: z
      .enum(["system", "ar", "en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"])
      .catch("system"),
    sendBehavior: z.enum(["interrupt", "steer", "queue"]).catch("steer"),
    serviceUrlBehavior: z.enum(["ask", "in-app", "external"]).catch("ask"),
    terminalScrollbackLines: clampedNumber(
      MIN_TERMINAL_SCROLLBACK_LINES,
      MAX_TERMINAL_SCROLLBACK_LINES,
    ).catch(DEFAULT_TERMINAL_SCROLLBACK_LINES),
    useLegacyTerminalRenderer: z.boolean().catch(false),
    uiFontFamily: sanitizedFontFamily().catch(""),
    monoFontFamily: sanitizedFontFamily().catch(""),
    uiBaseFontSize: clampedNumber(MIN_UI_BASE_FONT_SIZE, MAX_UI_BASE_FONT_SIZE)
      .optional()
      .catch(undefined),
    contentFontSize: clampedNumber(MIN_CONTENT_FONT_SIZE, MAX_CONTENT_FONT_SIZE)
      .optional()
      .catch(DEFAULT_CONTENT_FONT_SIZE),
    // COMPAT(uiFontSizeScale): replaced by the literal base size in v0.4, remove after 2027-08-17.
    uiFontSize: clampedNumber(11, 24).optional().catch(undefined),
    codeFontSize: clampedNumber(MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE).catch(
      DEFAULT_CODE_FONT_SIZE,
    ),
    syntaxTheme: z.string().refine(isSyntaxThemeId).catch("one"),
    workspaceTitleSource: z.enum(["title", "branch"]).catch("title"),
    sidebarWorkspaceTrailing: z.enum(["diff", "timestamp", "none"]).catch("diff"),
    sidebarRowItems: SidebarRowItemsSchema,
    sidebarChecksDisplay: z
      .enum(["iconAndText", "icon", "none"])
      .optional()
      .catch(DEFAULT_SIDEBAR_CHECKS_DISPLAY),
    sidebarNavItems: z.array(z.object({ key: z.string(), visible: z.boolean() })).catch([]),
    autoExpandReasoning: z.boolean().catch(false),
    toolCallDetailLevel: z
      .enum(["overview", "detailed"])
      .or(z.literal("concise").transform(() => "overview" as const))
      .optional()
      .catch("detailed"),
    // COMPAT(compactToolCalls): migrated in v0.1.105, remove after 2027-01-12.
    compactToolCalls: z.boolean().optional().catch(undefined),
    chatOutlineEnabled: z.boolean().catch(true),
    vimKeybindings: z.boolean().catch(false),
    openInSidePane: z
      .object({
        explorerFiles: z.boolean().catch(false),
        diffs: z.boolean().optional(),
        // COMPAT(diffDestinationPreference): legacy split preferences, remove after 2027-02-26.
        explorerChanges: z.boolean().optional(),
        changesLinks: z.boolean().optional(),
        chatFiles: z.boolean().catch(false),
        diffFiles: z.boolean().catch(false),
        subagents: z.boolean().catch(false),
        // COMPAT(pullRequestOpenLocation): legacy side-pane toggle, remove after 2027-02-26.
        pullRequests: z.boolean().optional(),
      })
      .transform(({ explorerChanges, changesLinks, pullRequests, ...preferences }) => ({
        ...preferences,
        diffs: preferences.diffs ?? explorerChanges ?? changesLinks ?? false,
        legacyPullRequestsInSidePane: pullRequests,
      }))
      .catch({
        ...DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES,
        legacyPullRequestsInSidePane: undefined,
      }),
    pullRequestOpenLocation: z.enum(["main", "side", "explorer"]).optional(),
    // COMPAT(explorerSidebarRouting): replaced by source-specific side-pane preferences in v0.6.
    openSupportingTabsInSidePanel: z.boolean().optional().catch(undefined),
    // COMPAT(rendererDesktopSettings): these fields used to share this renderer-owned key.
    manageBuiltInDaemon: z.boolean().optional().catch(undefined),
    releaseChannel: z.enum(["stable", "beta"]).optional().catch(undefined),
  })
  .transform((stored) => {
    const { legacyPullRequestsInSidePane, ...openInSidePane } = stored.openInSidePane;
    const needsWrite =
      (stored.uiBaseFontSize === undefined && stored.uiFontSize !== undefined) ||
      stored.contentFontSize === undefined;
    const uiBaseFontSize =
      stored.uiBaseFontSize ??
      (stored.uiFontSize === undefined
        ? DEFAULT_UI_BASE_FONT_SIZE
        : Math.round((FONT_SIZE.base * stored.uiFontSize) / 16));
    const sidebarChecksDisplay =
      stored.sidebarChecksDisplay ??
      (isChecksHiddenByLegacyRowItem(stored.sidebarRowItems)
        ? "none"
        : DEFAULT_SIDEBAR_CHECKS_DISPLAY);
    const toolCallDetailLevel =
      stored.toolCallDetailLevel ?? (stored.compactToolCalls ? "overview" : "detailed");
    return {
      ...stored,
      openInSidePane,
      pullRequestOpenLocation:
        stored.pullRequestOpenLocation ?? (legacyPullRequestsInSidePane ? "side" : "explorer"),
      uiBaseFontSize,
      contentFontSize: stored.contentFontSize ?? uiBaseFontSize,
      sidebarChecksDisplay,
      sidebarRowItems: {
        ...stored.sidebarRowItems,
        services:
          stored.sidebarRowItems.services ??
          (stored.sidebarRowItems.scripts === false ? false : DEFAULT_SIDEBAR_ROW_ITEMS.services),
      },
      toolCallDetailLevel,
      needsWrite,
    };
  })
  .catch(DEFAULT_STORED_APP_SETTINGS);

type StoredAppSettings = z.output<typeof StoredAppSettingsSchema>;
export type PersistedAppSettings = Omit<StoredAppSettings, "needsWrite">;

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface DesktopSettingsBridge {
  isElectron(): boolean;
  loadDesktopSettings(): Promise<DesktopSettings>;
  migrateLegacyDesktopSettings(input: {
    manageBuiltInDaemon?: boolean;
    releaseChannel?: ReleaseChannel;
  }): Promise<void>;
}

export interface SettingsDeps {
  storage: KeyValueStorage;
  desktop: DesktopSettingsBridge;
}

export async function saveAppSettings(input: {
  queryClient: QueryClient;
  updates: AppSettingsUpdate;
  deps: SettingsDeps;
}): Promise<void> {
  const storedCurrent =
    input.queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ??
    (await loadAppSettingsFromStorage(input.deps));
  const current = normalizeAppSettings(storedCurrent);
  const updates = typeof input.updates === "function" ? input.updates(current) : input.updates;
  const next = { ...current, ...updates };
  input.queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
  await writeAppSettings(
    input.deps.storage,
    (await readSettingsObject(input.deps.storage, APP_SETTINGS_KEY)) ??
      StoredAppSettingsSchema.parse({}),
    next,
  );
}

export async function loadAppSettingsFromStorage(deps: SettingsDeps): Promise<AppSettings> {
  try {
    const read = await readAppSettings(deps);
    if (read.needsWrite) {
      await writeAppSettings(deps.storage, read.stored, read.settings);
    }
    const { needsWrite: _needsWrite, ...stored } = read.stored;
    return await migrateAppSettings(read.settings, deps.storage, stored, { native: isNative });
  } catch (error) {
    console.error("[AppSettings] Failed to load settings:", error);
    throw error;
  }
}

/**
 * Reads whichever of the settings blobs exists, without migrating. `needsWrite` covers the reads
 * that produce settings the stored blob does not already spell out.
 */
async function readAppSettings(
  deps: SettingsDeps,
): Promise<{ settings: AppSettings; needsWrite: boolean; stored: StoredAppSettings }> {
  const stored = await readSettingsObject(deps.storage, APP_SETTINGS_KEY);
  if (stored) {
    return {
      settings: normalizeAppSettings(stored),
      // COMPAT(uiFontSizeScale): persist the converted base size, remove after 2027-08-17.
      needsWrite: stored.needsWrite,
      stored,
    };
  }

  const legacyStored = await readSettingsObject(deps.storage, LEGACY_SETTINGS_KEY);
  if (legacyStored) {
    return {
      settings: {
        ...DEFAULT_CLIENT_SETTINGS,
        ...pickAppSettingsFromLegacy(legacyStored),
      } satisfies AppSettings,
      needsWrite: true,
      stored: legacyStored,
    };
  }

  const defaultStored = StoredAppSettingsSchema.parse({});
  return { settings: DEFAULT_CLIENT_SETTINGS, needsWrite: true, stored: defaultStored };
}

export async function loadSettingsFromStorage(deps: SettingsDeps): Promise<Settings> {
  const legacyDesktopSettings = deps.desktop.isElectron()
    ? await loadLegacyDesktopSettingsFromStorage(deps.storage)
    : null;
  const appSettings = await loadAppSettingsFromStorage(deps);

  if (!deps.desktop.isElectron()) {
    return {
      ...DEFAULT_APP_SETTINGS,
      ...appSettings,
    };
  }

  if (legacyDesktopSettings) {
    await deps.desktop.migrateLegacyDesktopSettings(legacyDesktopSettings);
  }

  const desktopSettings = await deps.desktop.loadDesktopSettings();
  return {
    ...DEFAULT_APP_SETTINGS,
    ...appSettings,
    manageBuiltInDaemon: desktopSettings.daemon.manageBuiltInDaemon,
    releaseChannel: desktopSettings.releaseChannel,
  };
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const {
    needsWrite: _needsWrite,
    manageBuiltInDaemon: _manageBuiltInDaemon,
    releaseChannel: _releaseChannel,
    compactToolCalls: _compactToolCalls,
    uiFontSize: _uiFontSize,
    ...settings
  } = StoredAppSettingsSchema.parse(value);
  return settings;
}

function pickAppSettingsFromLegacy(legacy: StoredAppSettings): AppSettings {
  const settings = normalizeAppSettings(legacy);
  return {
    ...settings,
    // The legacy key rendered content on the interface ramp. Freeze that
    // rendered value into the new independent preference during migration.
    contentFontSize: legacy.uiBaseFontSize,
  };
}

export function parseTerminalScrollbackLines(value: unknown): number | null {
  let numericValue = NaN;
  if (typeof value === "number") {
    numericValue = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    numericValue = Number(value);
  }
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  return Math.min(
    MAX_TERMINAL_SCROLLBACK_LINES,
    Math.max(MIN_TERMINAL_SCROLLBACK_LINES, Math.floor(numericValue)),
  );
}

export function parseClampedFontSize(
  value: unknown,
  bounds: { min: number; max: number },
): number | null {
  let numericValue = NaN;
  if (typeof value === "number") {
    numericValue = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    numericValue = Number(value);
  }
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(numericValue)));
}

export function sanitizeFontFamily(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return ""; // explicit empty = default
  }
  if (trimmed.length > MAX_FONT_FAMILY_LENGTH) {
    return null;
  }
  if (/[;{}<>]/.test(trimmed)) {
    return null; // would break the web CSS font-family declaration
  }
  if ([...trimmed].some((char) => char.charCodeAt(0) <= 0x1f)) {
    return null; // control chars would corrupt the font-family string
  }
  return trimmed; // quotes/commas are legit in stacks
}

async function loadLegacyDesktopSettingsFromStorage(storage: KeyValueStorage): Promise<{
  manageBuiltInDaemon?: boolean;
  releaseChannel?: ReleaseChannel;
} | null> {
  const stored = await loadRendererSettingsPayload(storage);
  if (!stored) {
    return null;
  }

  const result: {
    manageBuiltInDaemon?: boolean;
    releaseChannel?: ReleaseChannel;
  } = {};

  if (stored.manageBuiltInDaemon !== undefined) {
    result.manageBuiltInDaemon = stored.manageBuiltInDaemon;
  }
  if (stored.releaseChannel !== undefined) {
    result.releaseChannel = stored.releaseChannel;
  }

  return Object.keys(result).length > 0 ? result : null;
}

async function loadRendererSettingsPayload(
  storage: KeyValueStorage,
): Promise<StoredAppSettings | null> {
  const current = await readSettingsObject(storage, APP_SETTINGS_KEY);
  if (current) {
    return current;
  }

  return readSettingsObject(storage, LEGACY_SETTINGS_KEY);
}

async function readSettingsObject(
  storage: KeyValueStorage,
  key: string,
): Promise<StoredAppSettings | null> {
  const raw = await storage.getItem(key);
  if (raw === null) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    console.warn(`[AppSettings] Removing corrupt ${key}: invalid JSON.`);
    await storage.removeItem(key);
    return null;
  }
  return StoredAppSettingsSchema.parse(decoded);
}

async function writeAppSettings(
  storage: KeyValueStorage,
  stored: StoredAppSettings,
  settings: AppSettings,
): Promise<void> {
  const { needsWrite: _needsWrite, ...persistedStored } = stored;
  const storedSidebarRowItems = persistedStored.sidebarRowItems;
  await storage.setItem(
    APP_SETTINGS_KEY,
    JSON.stringify({
      ...persistedStored,
      ...settings,
      sidebarRowItems: { ...storedSidebarRowItems, ...settings.sidebarRowItems },
    }),
  );
}
