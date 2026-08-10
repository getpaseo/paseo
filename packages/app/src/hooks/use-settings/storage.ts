import { isSyntaxThemeId, type SyntaxThemeId } from "@getpaseo/highlight";
import type { QueryClient } from "@tanstack/react-query";
import type { DesktopSettings } from "@/desktop/settings/desktop-settings";
import { parseAppLanguage, type AppLanguage } from "@/i18n/locales";
import {
  DEFAULT_SIDEBAR_CHECKS_DISPLAY,
  parseSidebarChecksDisplay,
  type SidebarChecksDisplay,
} from "@/components/sidebar/display-preferences/checks-display";
import {
  DEFAULT_SIDEBAR_ROW_ITEMS,
  isChecksHiddenByLegacyRowItem,
  parseSidebarRowItems,
  type SidebarRowItems,
} from "@/components/sidebar/display-preferences/row-items";
import { THEME_TO_UNISTYLES, type ThemeName } from "@/styles/theme";

export const APP_SETTINGS_KEY = "@paseo:app-settings";
export const APP_SETTINGS_QUERY_KEY = ["app-settings"];
const LEGACY_SETTINGS_KEY = "@paseo:settings";

export type SendBehavior = "interrupt" | "queue";
export type ReleaseChannel = "stable" | "beta";
export type ServiceUrlBehavior = "ask" | "in-app" | "external";
export type WorkspaceTitleSource = "title" | "branch";
/** What a sidebar workspace row shows in the space to the right of its title. */
export type SidebarWorkspaceTrailing = "diff" | "timestamp" | "none";
export type ToolCallDetailLevel = "overview" | "detailed";
const VALID_THEMES = new Set<string>([...Object.keys(THEME_TO_UNISTYLES), "auto"]);
const VALID_SERVICE_URL_BEHAVIORS = new Set<ServiceUrlBehavior>(["ask", "in-app", "external"]);
const VALID_WORKSPACE_TITLE_SOURCES = new Set<WorkspaceTitleSource>(["title", "branch"]);
const VALID_SIDEBAR_WORKSPACE_TRAILINGS = new Set<SidebarWorkspaceTrailing>([
  "diff",
  "timestamp",
  "none",
]);
const VALID_TOOL_CALL_DETAIL_LEVELS = new Set<ToolCallDetailLevel>(["overview", "detailed"]);
export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 10_000;
export const MIN_TERMINAL_SCROLLBACK_LINES = 0;
export const MAX_TERMINAL_SCROLLBACK_LINES = 1_000_000;
export const DEFAULT_UI_FONT_SIZE = 16; // == FONT_SIZE.base
export const MIN_UI_FONT_SIZE = 11;
export const MAX_UI_FONT_SIZE = 24;
export const DEFAULT_CODE_FONT_SIZE = 12; // == FONT_SIZE.code
export const MIN_CODE_FONT_SIZE = 9;
export const MAX_CODE_FONT_SIZE = 22; // line-height 1.5×22=33 stays safe
export const MAX_FONT_FAMILY_LENGTH = 200;

export interface AppSettings {
  theme: ThemeName | "auto";
  language: AppLanguage;
  sendBehavior: SendBehavior;
  serviceUrlBehavior: ServiceUrlBehavior;
  terminalScrollbackLines: number;
  useLegacyTerminalRenderer: boolean;
  uiFontFamily: string; // "" = platform default UI stack
  monoFontFamily: string; // "" = platform default mono stack
  uiFontSize: number; // clamped px, default 16
  codeFontSize: number; // clamped px, default 12
  syntaxTheme: SyntaxThemeId; // default "one"
  workspaceTitleSource: WorkspaceTitleSource;
  sidebarWorkspaceTrailing: SidebarWorkspaceTrailing;
  sidebarRowItems: SidebarRowItems;
  sidebarChecksDisplay: SidebarChecksDisplay;
  autoExpandReasoning: boolean;
  toolCallDetailLevel: ToolCallDetailLevel;
  chatOutlineEnabled: boolean;
  vimKeybindings: boolean;
}

export interface Settings extends AppSettings {
  manageBuiltInDaemon: boolean;
  releaseChannel: ReleaseChannel;
}

/**
 * `sidebarRowItems` is widened back to `unknown` because it is still read for a value the
 * current shape no longer has — see `isChecksHiddenByLegacyRowItem`.
 */
type StoredAppSettings = Partial<Omit<AppSettings, "sidebarRowItems">> & {
  compactToolCalls?: unknown;
  sidebarRowItems?: unknown;
};

export const DEFAULT_CLIENT_SETTINGS: AppSettings = {
  theme: "auto",
  language: "system",
  sendBehavior: "interrupt",
  serviceUrlBehavior: "ask",
  terminalScrollbackLines: DEFAULT_TERMINAL_SCROLLBACK_LINES,
  useLegacyTerminalRenderer: false,
  uiFontFamily: "",
  monoFontFamily: "",
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  syntaxTheme: "one",
  workspaceTitleSource: "title",
  sidebarWorkspaceTrailing: "diff",
  sidebarRowItems: DEFAULT_SIDEBAR_ROW_ITEMS,
  sidebarChecksDisplay: DEFAULT_SIDEBAR_CHECKS_DISPLAY,
  autoExpandReasoning: false,
  toolCallDetailLevel: "detailed",
  chatOutlineEnabled: true,
  vimKeybindings: false,
};

export const DEFAULT_APP_SETTINGS: Settings = {
  ...DEFAULT_CLIENT_SETTINGS,
  manageBuiltInDaemon: true,
  releaseChannel: "stable",
};

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
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
  updates: Partial<AppSettings>;
  deps: SettingsDeps;
}): Promise<void> {
  const storedCurrent =
    input.queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ??
    (await loadAppSettingsFromStorage(input.deps));
  const current = normalizeAppSettings(storedCurrent);
  const next = { ...current, ...input.updates };
  input.queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
  await input.deps.storage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
}

export async function loadAppSettingsFromStorage(deps: SettingsDeps): Promise<AppSettings> {
  try {
    const stored = await deps.storage.getItem(APP_SETTINGS_KEY);
    if (stored) {
      return normalizeAppSettings(JSON.parse(stored));
    }

    const legacyStored = await deps.storage.getItem(LEGACY_SETTINGS_KEY);
    if (legacyStored) {
      const legacyParsed = JSON.parse(legacyStored) as Record<string, unknown>;
      const next = {
        ...DEFAULT_CLIENT_SETTINGS,
        ...pickAppSettingsFromLegacy(legacyParsed),
      } satisfies AppSettings;
      await deps.storage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
      return next;
    }

    await deps.storage.setItem(APP_SETTINGS_KEY, JSON.stringify(DEFAULT_CLIENT_SETTINGS));
    return DEFAULT_CLIENT_SETTINGS;
  } catch (error) {
    console.error("[AppSettings] Failed to load settings:", error);
    throw error;
  }
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
  const stored =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as StoredAppSettings)
      : {};
  return { ...DEFAULT_CLIENT_SETTINGS, ...pickAppSettings(stored) };
}

function parseToolCallDetailLevel(stored: StoredAppSettings): ToolCallDetailLevel | null {
  if (stored.toolCallDetailLevel !== undefined) {
    if (
      typeof stored.toolCallDetailLevel === "string" &&
      VALID_TOOL_CALL_DETAIL_LEVELS.has(stored.toolCallDetailLevel)
    ) {
      return stored.toolCallDetailLevel;
    }
    // COMPAT(toolCallDetailLevelConcise): removed in v0.1.107; legacy "concise" values
    // deliberately follow the unknown-value fallback. Remove after 2027-01-14.
    return "overview";
  }
  if (typeof stored.compactToolCalls === "boolean") {
    // COMPAT(compactToolCalls): migrated in v0.1.105, remove after 2027-01-12.
    return stored.compactToolCalls ? "overview" : "detailed";
  }
  return null;
}

function parseStoredSidebarChecksDisplay(stored: StoredAppSettings): SidebarChecksDisplay | null {
  const display = parseSidebarChecksDisplay(stored.sidebarChecksDisplay);
  if (display !== null) {
    return display;
  }
  // COMPAT(sidebarRowItemsChecks): migrated in v0.3.0, remove after 2027-08-05.
  return isChecksHiddenByLegacyRowItem(stored.sidebarRowItems) ? "none" : null;
}

function pickBooleanAppSettings(stored: StoredAppSettings): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (typeof stored.useLegacyTerminalRenderer === "boolean") {
    result.useLegacyTerminalRenderer = stored.useLegacyTerminalRenderer;
  }
  if (typeof stored.vimKeybindings === "boolean") {
    result.vimKeybindings = stored.vimKeybindings;
  }
  if (typeof stored.chatOutlineEnabled === "boolean") {
    result.chatOutlineEnabled = stored.chatOutlineEnabled;
  }
  return result;
}

/**
 * The settings whose stored value only has to be a member of a fixed set. Grouped like the
 * boolean settings are: the numeric and font settings need real parsing and clamping, these
 * need a membership check and nothing else.
 */
function pickEnumAppSettings(stored: StoredAppSettings): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (typeof stored.theme === "string" && VALID_THEMES.has(stored.theme)) {
    result.theme = stored.theme;
  }
  if (stored.sendBehavior === "interrupt" || stored.sendBehavior === "queue") {
    result.sendBehavior = stored.sendBehavior;
  }
  if (
    typeof stored.serviceUrlBehavior === "string" &&
    VALID_SERVICE_URL_BEHAVIORS.has(stored.serviceUrlBehavior)
  ) {
    result.serviceUrlBehavior = stored.serviceUrlBehavior;
  }
  if (typeof stored.syntaxTheme === "string" && isSyntaxThemeId(stored.syntaxTheme)) {
    result.syntaxTheme = stored.syntaxTheme;
  }
  if (
    typeof stored.workspaceTitleSource === "string" &&
    VALID_WORKSPACE_TITLE_SOURCES.has(stored.workspaceTitleSource)
  ) {
    result.workspaceTitleSource = stored.workspaceTitleSource;
  }
  if (
    typeof stored.sidebarWorkspaceTrailing === "string" &&
    VALID_SIDEBAR_WORKSPACE_TRAILINGS.has(stored.sidebarWorkspaceTrailing)
  ) {
    result.sidebarWorkspaceTrailing = stored.sidebarWorkspaceTrailing;
  }
  return result;
}

function pickAppSettings(stored: StoredAppSettings): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  Object.assign(result, pickEnumAppSettings(stored));
  if (stored.sidebarRowItems !== undefined) {
    result.sidebarRowItems = parseSidebarRowItems(stored.sidebarRowItems);
  }
  const sidebarChecksDisplay = parseStoredSidebarChecksDisplay(stored);
  if (sidebarChecksDisplay !== null) {
    result.sidebarChecksDisplay = sidebarChecksDisplay;
  }
  const language = parseAppLanguage(stored.language);
  if (language !== null) {
    result.language = language;
  }
  const terminalScrollbackLines = parseTerminalScrollbackLines(stored.terminalScrollbackLines);
  if (terminalScrollbackLines !== null) {
    result.terminalScrollbackLines = terminalScrollbackLines;
  }
  const uiFontFamily = sanitizeFontFamily(stored.uiFontFamily);
  if (uiFontFamily !== null) {
    result.uiFontFamily = uiFontFamily;
  }
  const monoFontFamily = sanitizeFontFamily(stored.monoFontFamily);
  if (monoFontFamily !== null) {
    result.monoFontFamily = monoFontFamily;
  }
  const uiFontSize = parseClampedFontSize(stored.uiFontSize, {
    min: MIN_UI_FONT_SIZE,
    max: MAX_UI_FONT_SIZE,
  });
  if (uiFontSize !== null) {
    result.uiFontSize = uiFontSize;
  }
  const codeFontSize = parseClampedFontSize(stored.codeFontSize, {
    min: MIN_CODE_FONT_SIZE,
    max: MAX_CODE_FONT_SIZE,
  });
  if (codeFontSize !== null) {
    result.codeFontSize = codeFontSize;
  }
  Object.assign(result, pickBooleanAppSettings(stored));
  if (typeof stored.autoExpandReasoning === "boolean") {
    result.autoExpandReasoning = stored.autoExpandReasoning;
  }
  const toolCallDetailLevel = parseToolCallDetailLevel(stored);
  if (toolCallDetailLevel !== null) {
    result.toolCallDetailLevel = toolCallDetailLevel;
  }
  return result;
}

function pickAppSettingsFromLegacy(legacy: Record<string, unknown>): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (legacy.theme === "dark" || legacy.theme === "light" || legacy.theme === "auto") {
    result.theme = legacy.theme;
  }
  return result;
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

  if (typeof stored.manageBuiltInDaemon === "boolean") {
    result.manageBuiltInDaemon = stored.manageBuiltInDaemon;
  }
  if (stored.releaseChannel === "stable" || stored.releaseChannel === "beta") {
    result.releaseChannel = stored.releaseChannel;
  }

  return Object.keys(result).length > 0 ? result : null;
}

async function loadRendererSettingsPayload(
  storage: KeyValueStorage,
): Promise<Record<string, unknown> | null> {
  const current = await storage.getItem(APP_SETTINGS_KEY);
  if (current) {
    return JSON.parse(current) as Record<string, unknown>;
  }

  const legacy = await storage.getItem(LEGACY_SETTINGS_KEY);
  if (!legacy) {
    return null;
  }
  return JSON.parse(legacy) as Record<string, unknown>;
}
