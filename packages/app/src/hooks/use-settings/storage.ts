import { isSyntaxThemeId, type SyntaxThemeId } from "@getpaseo/highlight";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
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
  SIDEBAR_ROW_ITEMS,
  type SidebarRowItems,
} from "@/components/sidebar/display-preferences/row-items";
import { isNative } from "@/constants/platform";
import {
  FONT_SIZE,
  PLUGIN_THEME_PREFERENCE,
  THEME_OPTIONS,
  type ThemePreference,
} from "@/styles/theme";
import { APP_SETTINGS_KEY, LEGACY_SETTINGS_KEY } from "./keys";
import { migrateAppSettings } from "./migrations";

export { APP_SETTINGS_KEY } from "./keys";
export const APP_SETTINGS_QUERY_KEY = ["app-settings"];

export type SendBehavior = ActiveTurnBehavior | "queue";
export type ReleaseChannel = "stable" | "beta";
export type ServiceUrlBehavior = "ask" | "in-app" | "external";
export type WorkspaceTitleSource = "title" | "branch";
/** What a sidebar workspace row shows in the space to the right of its title. */
export type SidebarWorkspaceTrailing = "diff" | "timestamp" | "none";
export type ToolCallDetailLevel = "overview" | "detailed";

const VALID_THEMES = new Set<ThemePreference>([
  ...THEME_OPTIONS.map((option) => option.name),
  PLUGIN_THEME_PREFERENCE,
] as ThemePreference[]);
/** Where the theme picker lands when the persisted preference cannot be honoured. */
export const DEFAULT_THEME_PREFERENCE = "auto" satisfies ThemePreference;
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
export function defaultUiBaseFontSize(native: boolean): number {
  return native ? 15 : FONT_SIZE.base;
}

export const DEFAULT_UI_BASE_FONT_SIZE = defaultUiBaseFontSize(isNative);
export const MIN_UI_BASE_FONT_SIZE = 10;
export const MAX_UI_BASE_FONT_SIZE = 21;
export function defaultContentFontSize(native: boolean): number {
  return native ? 15 : FONT_SIZE.content;
}

export const DEFAULT_CONTENT_FONT_SIZE = defaultContentFontSize(isNative);
export const MIN_CONTENT_FONT_SIZE = 10;
export const MAX_CONTENT_FONT_SIZE = 21;
export const DEFAULT_CODE_FONT_SIZE = 12; // == FONT_SIZE.code
export const MIN_CODE_FONT_SIZE = 9;
export const MAX_CODE_FONT_SIZE = 22; // line-height 1.5×22=33 stays safe
export const MAX_FONT_FAMILY_LENGTH = 200;

function isEnumValue<Value extends string>(
  values: ReadonlySet<Value>,
  value: unknown,
): value is Value {
  return typeof value === "string" && values.has(value as Value);
}

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
  contentFontSize: number; // clamped px, default 15
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
  /** Route implicitly opened supporting tabs into the Side panel. Desktop only. */
  openSupportingTabsInSidePanel: boolean;
}

export interface Settings extends AppSettings {
  manageBuiltInDaemon: boolean;
  releaseChannel: ReleaseChannel;
}

type StoredAppSettings = Record<string, unknown>;

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
  autoExpandReasoning: false,
  toolCallDetailLevel: "detailed",
  chatOutlineEnabled: true,
  vimKeybindings: false,
  openSupportingTabsInSidePanel: true,
};

export const DEFAULT_APP_SETTINGS: Settings = {
  ...DEFAULT_CLIENT_SETTINGS,
  manageBuiltInDaemon: true,
  releaseChannel: "stable",
};

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
  updates: Partial<AppSettings>;
  deps: SettingsDeps;
}): Promise<void> {
  const storedCurrent =
    input.queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ??
    (await loadAppSettingsFromStorage(input.deps));
  const current = normalizeAppSettings(storedCurrent);
  const next = { ...current, ...input.updates };
  input.queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
  await writeAppSettings(
    input.deps.storage,
    (await readSettingsObject(input.deps.storage, APP_SETTINGS_KEY)) ?? {},
    next,
  );
}

export async function loadAppSettingsFromStorage(deps: SettingsDeps): Promise<AppSettings> {
  try {
    const read = await readAppSettings(deps);
    if (read.needsWrite) {
      await writeAppSettings(deps.storage, read.stored, read.settings);
    }
    return await migrateAppSettings(read.settings, deps.storage, read.stored);
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
      needsWrite:
        (stored.uiBaseFontSize === undefined && stored.uiFontSize !== undefined) ||
        stored.contentFontSize === undefined,
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

  return { settings: DEFAULT_CLIENT_SETTINGS, needsWrite: true, stored: {} };
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
  const stored = isPlainJsonObject(value) ? value : {};
  const picked = pickAppSettings(stored);
  warnDiscardedAppSettings(stored);
  return {
    ...DEFAULT_CLIENT_SETTINGS,
    ...picked,
  };
}

function warnDiscardedAppSettings(stored: StoredAppSettings): void {
  const discarded = (key: string, valid: boolean): void => {
    if (stored[key] !== undefined && !valid) {
      console.warn(`[AppSettings] Ignoring invalid ${key}.`);
    }
  };

  discarded("theme", isEnumValue(VALID_THEMES, stored.theme));
  discarded(
    "sendBehavior",
    stored.sendBehavior === "interrupt" ||
      stored.sendBehavior === "steer" ||
      stored.sendBehavior === "queue",
  );
  discarded(
    "serviceUrlBehavior",
    isEnumValue(VALID_SERVICE_URL_BEHAVIORS, stored.serviceUrlBehavior),
  );
  discarded("language", parseAppLanguage(stored.language) !== null);
  discarded(
    "syntaxTheme",
    typeof stored.syntaxTheme === "string" && isSyntaxThemeId(stored.syntaxTheme),
  );
  discarded(
    "workspaceTitleSource",
    isEnumValue(VALID_WORKSPACE_TITLE_SOURCES, stored.workspaceTitleSource),
  );
  discarded(
    "sidebarWorkspaceTrailing",
    isEnumValue(VALID_SIDEBAR_WORKSPACE_TRAILINGS, stored.sidebarWorkspaceTrailing),
  );
  discarded(
    "sidebarChecksDisplay",
    parseSidebarChecksDisplay(stored.sidebarChecksDisplay) !== null,
  );
  discarded(
    "terminalScrollbackLines",
    parseTerminalScrollbackLines(stored.terminalScrollbackLines) !== null,
  );
  discarded("uiFontFamily", sanitizeFontFamily(stored.uiFontFamily) !== null);
  discarded("monoFontFamily", sanitizeFontFamily(stored.monoFontFamily) !== null);
  discarded(
    "uiBaseFontSize",
    parseClampedFontSize(stored.uiBaseFontSize, {
      min: MIN_UI_BASE_FONT_SIZE,
      max: MAX_UI_BASE_FONT_SIZE,
    }) !== null,
  );
  discarded(
    "contentFontSize",
    parseClampedFontSize(stored.contentFontSize, {
      min: MIN_CONTENT_FONT_SIZE,
      max: MAX_CONTENT_FONT_SIZE,
    }) !== null,
  );
  discarded(
    "codeFontSize",
    parseClampedFontSize(stored.codeFontSize, {
      min: MIN_CODE_FONT_SIZE,
      max: MAX_CODE_FONT_SIZE,
    }) !== null,
  );
  discarded("uiFontSize", parseClampedFontSize(stored.uiFontSize, { min: 11, max: 24 }) !== null);
  for (const key of [
    "useLegacyTerminalRenderer",
    "vimKeybindings",
    "chatOutlineEnabled",
    "openSupportingTabsInSidePanel",
    "autoExpandReasoning",
  ]) {
    discarded(key, typeof stored[key] === "boolean");
  }
  discarded(
    "toolCallDetailLevel",
    isEnumValue(VALID_TOOL_CALL_DETAIL_LEVELS, stored.toolCallDetailLevel) ||
      stored.toolCallDetailLevel === "concise",
  );
  discarded("compactToolCalls", typeof stored.compactToolCalls === "boolean");
  if (
    stored.pluginThemeId !== undefined &&
    stored.pluginThemeId !== null &&
    typeof stored.pluginThemeId !== "string"
  ) {
    console.warn("[AppSettings] Ignoring invalid pluginThemeId.");
  }
  if (stored.sidebarRowItems !== undefined && !isPlainJsonObject(stored.sidebarRowItems)) {
    console.warn("[AppSettings] Ignoring invalid sidebarRowItems.");
  } else if (isPlainJsonObject(stored.sidebarRowItems)) {
    for (const key of SIDEBAR_ROW_ITEMS) {
      if (
        stored.sidebarRowItems[key] !== undefined &&
        typeof stored.sidebarRowItems[key] !== "boolean"
      ) {
        console.warn(`[AppSettings] Ignoring invalid sidebarRowItems.${key}.`);
      }
    }
  }
}

function parseToolCallDetailLevel(stored: StoredAppSettings): ToolCallDetailLevel | null {
  if (stored.toolCallDetailLevel !== undefined) {
    if (isEnumValue(VALID_TOOL_CALL_DETAIL_LEVELS, stored.toolCallDetailLevel)) {
      return stored.toolCallDetailLevel;
    }
    // COMPAT(toolCallDetailLevelConcise): removed in v0.1.107; legacy "concise" values
    // keep their former meaning. Remove after 2027-01-14.
    return stored.toolCallDetailLevel === "concise" ? "overview" : null;
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
  if (typeof stored.openSupportingTabsInSidePanel === "boolean") {
    result.openSupportingTabsInSidePanel = stored.openSupportingTabsInSidePanel;
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
  if (isEnumValue(VALID_THEMES, stored.theme)) {
    result.theme = stored.theme;
  }
  if (
    stored.sendBehavior === "interrupt" ||
    stored.sendBehavior === "steer" ||
    stored.sendBehavior === "queue"
  ) {
    result.sendBehavior = stored.sendBehavior;
  }
  if (isEnumValue(VALID_SERVICE_URL_BEHAVIORS, stored.serviceUrlBehavior)) {
    result.serviceUrlBehavior = stored.serviceUrlBehavior;
  }
  if (typeof stored.syntaxTheme === "string" && isSyntaxThemeId(stored.syntaxTheme)) {
    result.syntaxTheme = stored.syntaxTheme;
  }
  if (isEnumValue(VALID_WORKSPACE_TITLE_SOURCES, stored.workspaceTitleSource)) {
    result.workspaceTitleSource = stored.workspaceTitleSource;
  }
  if (isEnumValue(VALID_SIDEBAR_WORKSPACE_TRAILINGS, stored.sidebarWorkspaceTrailing)) {
    result.sidebarWorkspaceTrailing = stored.sidebarWorkspaceTrailing;
  }
  return result;
}

function pickAppSettings(stored: StoredAppSettings): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  Object.assign(result, pickEnumAppSettings(stored));
  if (typeof stored.pluginThemeId === "string") {
    result.pluginThemeId = stored.pluginThemeId;
  }
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
  const uiBaseFontSize = parseClampedFontSize(stored.uiBaseFontSize, {
    min: MIN_UI_BASE_FONT_SIZE,
    max: MAX_UI_BASE_FONT_SIZE,
  });
  if (uiBaseFontSize !== null) {
    result.uiBaseFontSize = uiBaseFontSize;
  } else {
    const legacyUiFontSize = parseClampedFontSize(stored.uiFontSize, {
      min: 11,
      max: 24,
    });
    if (legacyUiFontSize !== null) {
      result.uiBaseFontSize = Math.round((FONT_SIZE.base * legacyUiFontSize) / 16);
    }
  }
  const contentFontSize = parseClampedFontSize(stored.contentFontSize, {
    min: MIN_CONTENT_FONT_SIZE,
    max: MAX_CONTENT_FONT_SIZE,
  });
  if (contentFontSize !== null) {
    result.contentFontSize = contentFontSize;
  } else if (stored.contentFontSize === undefined) {
    // Existing content followed the interface ramp. Preserve that rendered size
    // once, then persist the independent setting during the read migration.
    result.contentFontSize = result.uiBaseFontSize ?? DEFAULT_UI_BASE_FONT_SIZE;
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

function pickAppSettingsFromLegacy(legacy: StoredAppSettings): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (legacy.theme === "dark" || legacy.theme === "light" || legacy.theme === "auto") {
    result.theme = legacy.theme;
  }
  const legacyInterfaceSize = pickAppSettings(legacy).uiBaseFontSize;
  if (legacyInterfaceSize !== undefined) {
    result.uiBaseFontSize = legacyInterfaceSize;
  }
  // The legacy key rendered content on the interface ramp. Freeze that
  // rendered value into the new independent preference during migration.
  result.contentFontSize = legacyInterfaceSize ?? DEFAULT_UI_BASE_FONT_SIZE;
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
): Promise<StoredAppSettings | null> {
  const current = await readSettingsObject(storage, APP_SETTINGS_KEY);
  if (current) {
    return current;
  }

  return readSettingsObject(storage, LEGACY_SETTINGS_KEY);
}

function isPlainJsonObject(value: unknown): value is StoredAppSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettingsObject(
  storage: KeyValueStorage,
  key: string,
): Promise<StoredAppSettings | null> {
  const raw = await storage.getItem(key);
  if (raw === null) {
    return null;
  }

  try {
    const decoded: unknown = JSON.parse(raw);
    if (isPlainJsonObject(decoded)) {
      return decoded;
    }
    console.warn(`[AppSettings] Ignoring ${key}: expected a JSON object.`);
    return null;
  } catch {
    console.warn(`[AppSettings] Removing corrupt ${key}: invalid JSON.`);
    await storage.removeItem(key);
    return null;
  }
}

async function writeAppSettings(
  storage: KeyValueStorage,
  stored: StoredAppSettings,
  settings: AppSettings,
): Promise<void> {
  const storedSidebarRowItems = isPlainJsonObject(stored.sidebarRowItems)
    ? stored.sidebarRowItems
    : {};
  await storage.setItem(
    APP_SETTINGS_KEY,
    JSON.stringify({
      ...stored,
      ...settings,
      sidebarRowItems: { ...storedSidebarRowItems, ...settings.sidebarRowItems },
    }),
  );
}
