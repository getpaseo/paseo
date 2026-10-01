import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Monitor, Moon, Sun } from "@/components/icons/ui-icons";
import {
  SYNTAX_THEME_OPTIONS,
  type SyntaxThemeId,
  type SyntaxThemeOption,
} from "@getpaseo/highlight";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingsCard, SettingsSwitch } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useContributedThemes } from "@/appearance/provider";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import {
  MAX_CODE_FONT_SIZE,
  MAX_CONTENT_FONT_SIZE,
  MAX_UI_BASE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_CONTENT_FONT_SIZE,
  MIN_UI_BASE_FONT_SIZE,
  parseClampedFontSize,
  sanitizeFontFamily,
  useAppSettings,
  type AppSettings,
  DEFAULT_THEME_PREFERENCE,
} from "@/hooks/use-settings";
import {
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  DEFAULT_DISPLAY_FONT_STACK,
  ICON_SIZE,
  PLUGIN_THEME_PREFERENCE,
  THEME_OPTIONS,
  THEME_SWATCHES,
  type Theme,
} from "@/styles/theme";
import { isNative } from "@/constants/platform";
import type { PluginThemeOption } from "@/plugins/themes";
import { settingsStyles } from "@/styles/settings";
import { AppearancePreview } from "./appearance-preview";
import { SidebarNavSection } from "@/screens/settings/sidebar/sidebar-nav-section";

const ThemedSun = withUnistyles(Sun);
const ThemedMoon = withUnistyles(Moon);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedChevronDown = withUnistyles(ChevronDown);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type BuiltInThemePreference = Exclude<AppSettings["theme"], typeof PLUGIN_THEME_PREFERENCE>;

function getThemeLabel(t: TFunction, value: BuiltInThemePreference): string {
  return t(`settings.appearance.theme.options.${value}`);
}

const BARE_DEFAULT_STACKS: ReadonlySet<string> = new Set(["normal", "monospace"]);

function resolveDefaultStackPlaceholder(t: TFunction, stack: string): string {
  return BARE_DEFAULT_STACKS.has(stack) ? t("settings.appearance.fonts.systemDefault") : stack;
}

function sizeDraftToOverride(value: string): number | undefined {
  if (value.length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dropdownTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

interface ThemeLeadingProps {
  themeValue: BuiltInThemePreference;
}

function ThemeLeading({ themeValue }: ThemeLeadingProps) {
  switch (themeValue) {
    case "light":
      return <ThemedSun size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
    case "dark":
      return <ThemedMoon size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
    case "auto":
      return <ThemedMonitor size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
    default:
      return <ThemeSwatch color={THEME_SWATCHES[themeValue]} />;
  }
}

interface ThemeSwatchProps {
  color: string;
}

function ThemeSwatch({ color }: ThemeSwatchProps) {
  const swatchStyle = useMemo(() => [styles.swatch, { backgroundColor: color }], [color]);
  return <View style={swatchStyle} />;
}

const ACCENT_OPTIONS = [
  { id: "theme", color: "" },
  { id: "blue", color: "#4176e6" },
  { id: "violet", color: "#6d5dfc" },
  { id: "green", color: "#1f9d62" },
  { id: "teal", color: "#0e9f9a" },
  { id: "orange", color: "#e8743b" },
  { id: "pink", color: "#e0508f" },
] as const;

interface AccentSwatchProps {
  option: (typeof ACCENT_OPTIONS)[number];
  selected: boolean;
  onChange: (color: string) => void;
}

function AccentSwatch({ option, selected, onChange }: AccentSwatchProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onChange(option.color), [onChange, option.color]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const fillStyle = useMemo(
    () =>
      option.color ? [styles.accentFill, { backgroundColor: option.color }] : styles.accentAuto,
    [option.color],
  );
  return (
    <Pressable
      onPress={handlePress}
      style={selected ? styles.accentRingSelected : styles.accentRing}
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      accessibilityLabel={t(`settings.appearance.accent.options.${option.id}`)}
      testID={`accent-swatch-${option.id}`}
    >
      <View style={fillStyle} />
    </Pressable>
  );
}

interface AccentRowProps {
  value: string;
  onChange: (color: string) => void;
}

function AccentRow({ value, onChange }: AccentRowProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.rowWithBorder}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.accent.title")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.appearance.accent.hint")}</Text>
      </View>
      <View style={styles.accentSwatches} accessibilityRole="radiogroup">
        {ACCENT_OPTIONS.map((option) => (
          <AccentSwatch
            key={option.id}
            option={option}
            selected={value === option.color}
            onChange={onChange}
          />
        ))}
      </View>
    </View>
  );
}

interface ThemeMenuItemProps {
  themeValue: BuiltInThemePreference;
  selected: boolean;
  onChange: (theme: BuiltInThemePreference) => void;
}

function ThemeMenuItem({ themeValue, selected, onChange }: ThemeMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onChange(themeValue);
  }, [onChange, themeValue]);
  const leading = useMemo(() => <ThemeLeading themeValue={themeValue} />, [themeValue]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} leading={leading}>
      {getThemeLabel(t, themeValue)}
    </DropdownMenuItem>
  );
}

interface PluginThemeMenuItemProps {
  option: PluginThemeOption;
  selected: boolean;
  onSelect: (option: PluginThemeOption) => void;
}

function PluginThemeMenuItem({ option, selected, onSelect }: PluginThemeMenuItemProps) {
  const handleSelect = useCallback(() => {
    onSelect(option);
  }, [onSelect, option]);
  const leading = useMemo(() => <ThemeSwatch color={option.swatch} />, [option.swatch]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} leading={leading}>
      {option.name}
    </DropdownMenuItem>
  );
}

interface ThemeRowProps {
  value: AppSettings["theme"];
  pluginThemes: PluginThemeOption[];
  selectedPluginTheme: PluginThemeOption | null;
  onChange: (theme: BuiltInThemePreference) => void;
  onSelectPluginTheme: (option: PluginThemeOption) => void;
}

function ThemeRow({
  value,
  pluginThemes,
  selectedPluginTheme,
  onChange,
  onSelectPluginTheme,
}: ThemeRowProps) {
  const { t } = useTranslation();

  const builtInValue = value === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : value;
  const selectedLabel = selectedPluginTheme
    ? selectedPluginTheme.name
    : getThemeLabel(t, builtInValue);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.theme.title")}</Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.appearance.theme.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          {selectedPluginTheme ? (
            <ThemeSwatch color={selectedPluginTheme.swatch} />
          ) : (
            <ThemeLeading themeValue={builtInValue} />
          )}
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {THEME_OPTIONS.map((option, index) => {
            const previousOption = THEME_OPTIONS[index - 1];
            return (
              <Fragment key={option.name}>
                {previousOption && previousOption.group !== option.group ? (
                  <DropdownMenuSeparator />
                ) : null}
                <ThemeMenuItem
                  themeValue={option.name}
                  selected={selectedPluginTheme === null && builtInValue === option.name}
                  onChange={onChange}
                />
              </Fragment>
            );
          })}
          {pluginThemes.length > 0 ? <DropdownMenuSeparator /> : null}
          {pluginThemes.map((option) => (
            <PluginThemeMenuItem
              key={option.id}
              option={option}
              selected={selectedPluginTheme?.id === option.id}
              onSelect={onSelectPluginTheme}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

interface AutoExpandReasoningRowProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

function AutoExpandReasoningRow({ value, onChange }: AutoExpandReasoningRowProps) {
  const { t } = useTranslation();
  return (
    <SettingsSwitch
      label={t("settings.general.autoExpandReasoning.label")}
      hint={t("settings.general.autoExpandReasoning.description")}
      value={value}
      onValueChange={onChange}
    />
  );
}

interface ChatOutlineRowProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

function ChatOutlineRow({ value, onChange }: ChatOutlineRowProps) {
  const { t } = useTranslation();
  return (
    <SettingsSwitch
      label={t("settings.appearance.chatOutline.title")}
      hint={t("settings.appearance.chatOutline.description")}
      value={value}
      onValueChange={onChange}
    />
  );
}

const TOOL_CALL_DETAIL_LEVELS: readonly AppSettings["toolCallDetailLevel"][] = [
  "detailed",
  "overview",
];

function getToolCallDetailLevelLabel(
  t: TFunction,
  value: AppSettings["toolCallDetailLevel"],
): string {
  return t(`settings.general.toolCallDetail.options.${value}`);
}

interface ToolCallDetailMenuItemProps {
  value: AppSettings["toolCallDetailLevel"];
  selected: boolean;
  onChange: (value: AppSettings["toolCallDetailLevel"]) => void;
}

function ToolCallDetailMenuItem({ value, selected, onChange }: ToolCallDetailMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {getToolCallDetailLevelLabel(t, value)}
    </DropdownMenuItem>
  );
}

interface ToolCallDetailRowProps {
  value: AppSettings["toolCallDetailLevel"];
  onChange: (value: AppSettings["toolCallDetailLevel"]) => void;
}

function ToolCallDetailRow({ value, onChange }: ToolCallDetailRowProps) {
  const { t } = useTranslation();
  const selectedLabel = getToolCallDetailLevelLabel(t, value);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.general.toolCallDetail.label")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.general.toolCallDetail.description")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.general.toolCallDetail.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {TOOL_CALL_DETAIL_LEVELS.map((option) => (
            <ToolCallDetailMenuItem
              key={option}
              value={option}
              selected={value === option}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

const SESSION_CARD_STYLES: readonly AppSettings["sessionCardStyle"][] = ["card", "row"];

interface SessionCardStyleMenuItemProps {
  value: AppSettings["sessionCardStyle"];
  selected: boolean;
  onChange: (value: AppSettings["sessionCardStyle"]) => void;
}

function SessionCardStyleMenuItem({ value, selected, onChange }: SessionCardStyleMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {t(`settings.appearance.cards.${value}`)}
    </DropdownMenuItem>
  );
}

function SessionCardStyleRow({
  value,
  onChange,
}: {
  value: AppSettings["sessionCardStyle"];
  onChange: (value: AppSettings["sessionCardStyle"]) => void;
}) {
  const { t } = useTranslation();
  const selectedLabel = t(`settings.appearance.cards.${value}`);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.cards.sessionStyle")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.cards.sessionStyleHint")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.appearance.cards.sessionStyleAccessibility", {
            value: selectedLabel,
          })}
        >
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {SESSION_CARD_STYLES.map((option) => (
            <SessionCardStyleMenuItem
              key={option}
              value={option}
              selected={value === option}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

interface FontFamilyRowProps {
  title: string;
  hint: string;
  accessibilityLabel: string;
  placeholder: string;
  value: string;
  draft: string;
  withBorder: boolean;
  onChangeDraft: (value: string) => void;
  onCommit: (value: string) => void;
}

function FontFamilyRow({
  title,
  hint,
  accessibilityLabel,
  placeholder,
  value,
  draft,
  withBorder,
  onChangeDraft,
  onCommit,
}: FontFamilyRowProps) {
  const handleCommit = useCallback(() => {
    onCommit(draft);
  }, [draft, onCommit]);

  useEffect(() => {
    onChangeDraft(value);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <TextInput
        initialValue={draft}
        onChangeText={onChangeDraft}
        onBlur={handleCommit}
        onSubmitEditing={handleCommit}
        placeholder={placeholder}
        placeholderTextColor={styles.placeholderColor.color}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={styles.fontFamilyInput}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

interface FontSizeRowProps {
  title: string;
  hint: string;
  accessibilityLabel: string;
  draft: string;
  withBorder?: boolean;
  onChangeDraft: (value: string) => void;
  onCommit: () => void;
}

function FontSizeRow({
  title,
  hint,
  accessibilityLabel,
  draft,
  withBorder = true,
  onChangeDraft,
  onCommit,
}: FontSizeRowProps) {
  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <View style={styles.sizeField}>
        <TextInput
          initialValue={draft}
          onChangeText={onChangeDraft}
          onBlur={onCommit}
          onSubmitEditing={onCommit}
          keyboardType="number-pad"
          inputMode="numeric"
          selectTextOnFocus
          style={styles.sizeInput}
          accessibilityLabel={accessibilityLabel}
        />
        <Text style={styles.unit}>px</Text>
      </View>
    </View>
  );
}

function syntaxLabelForId(id: SyntaxThemeId): string {
  const option = SYNTAX_THEME_OPTIONS.find((entry) => entry.id === id);
  return option ? option.label : id;
}

interface SyntaxMenuItemProps {
  option: SyntaxThemeOption;
  selected: boolean;
  onChange: (id: SyntaxThemeId) => void;
}

function SyntaxMenuItem({ option, selected, onChange }: SyntaxMenuItemProps) {
  const handleSelect = useCallback(() => {
    onChange(option.id);
  }, [onChange, option.id]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {option.label}
    </DropdownMenuItem>
  );
}

interface SyntaxRowProps {
  value: SyntaxThemeId;
  onChange: (id: SyntaxThemeId) => void;
}

function SyntaxRow({ value, onChange }: SyntaxRowProps) {
  const { t } = useTranslation();
  const selectedLabel = syntaxLabelForId(value);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.appearance.syntax.highlightTheme")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.syntax.highlightThemeHint")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.appearance.syntax.highlightThemeAccessibility", {
            value: selectedLabel,
          })}
        >
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {SYNTAX_THEME_OPTIONS.map((option) => (
            <SyntaxMenuItem
              key={option.id}
              option={option}
              selected={value === option.id}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const {
    options: pluginThemes,
    selected: selectedPluginTheme,
    select: selectPluginTheme,
  } = useContributedThemes();
  const showInterfaceFontFamilyRow = !isNative;
  const uiFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_UI_FONT_STACK);
  const monoFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_MONO_FONT_STACK);
  const displayFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_DISPLAY_FONT_STACK);

  const [uiFontDraft, setUiFontDraft] = useState(settings.uiFontFamily);
  const [monoFontDraft, setMonoFontDraft] = useState(settings.monoFontFamily);
  const [displayFontDraft, setDisplayFontDraft] = useState(settings.displayFontFamily);
  const [uiBaseSizeDraft, setUiBaseSizeDraft] = useState(String(settings.uiBaseFontSize));
  const [contentSizeDraft, setContentSizeDraft] = useState(String(settings.contentFontSize));
  const [codeSizeDraft, setCodeSizeDraft] = useState(String(settings.codeFontSize));

  useEffect(() => {
    setUiBaseSizeDraft(String(settings.uiBaseFontSize));
  }, [settings.uiBaseFontSize]);
  useEffect(() => {
    setContentSizeDraft(String(settings.contentFontSize));
  }, [settings.contentFontSize]);
  useEffect(() => {
    setCodeSizeDraft(String(settings.codeFontSize));
  }, [settings.codeFontSize]);

  const handleAccentChange = useCallback(
    (accentColor: string) => {
      void updateSettings({ accentColor });
    },
    [updateSettings],
  );
  const handleThemeChange = useCallback(
    (theme: BuiltInThemePreference) => {
      void updateSettings({ theme });
    },
    [updateSettings],
  );

  const handlePluginThemeChange = useCallback(
    (option: PluginThemeOption) => {
      selectPluginTheme(option);
    },
    [selectPluginTheme],
  );

  const handleSyntaxThemeChange = useCallback(
    (syntaxTheme: SyntaxThemeId) => {
      void updateSettings({ syntaxTheme });
    },
    [updateSettings],
  );

  const handleAutoExpandReasoningChange = useCallback(
    (autoExpandReasoning: boolean) => {
      void updateSettings({ autoExpandReasoning });
    },
    [updateSettings],
  );

  const handleToolCallDetailLevelChange = useCallback(
    (toolCallDetailLevel: AppSettings["toolCallDetailLevel"]) => {
      void updateSettings({ toolCallDetailLevel });
    },
    [updateSettings],
  );

  const handleChatOutlineChange = useCallback(
    (chatOutlineEnabled: boolean) => {
      void updateSettings({ chatOutlineEnabled });
    },
    [updateSettings],
  );

  const commitUiFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setUiFontDraft(settings.uiFontFamily);
        return;
      }
      setUiFontDraft(sanitized);
      if (sanitized !== settings.uiFontFamily) {
        void updateSettings({ uiFontFamily: sanitized });
      }
    },
    [settings.uiFontFamily, updateSettings],
  );

  const commitMonoFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setMonoFontDraft(settings.monoFontFamily);
        return;
      }
      setMonoFontDraft(sanitized);
      if (sanitized !== settings.monoFontFamily) {
        void updateSettings({ monoFontFamily: sanitized });
      }
    },
    [settings.monoFontFamily, updateSettings],
  );

  const commitDisplayFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setDisplayFontDraft(settings.displayFontFamily);
        return;
      }
      setDisplayFontDraft(sanitized);
      if (sanitized !== settings.displayFontFamily) {
        void updateSettings({ displayFontFamily: sanitized });
      }
    },
    [settings.displayFontFamily, updateSettings],
  );

  const handleSessionCardStyleChange = useCallback(
    (sessionCardStyle: AppSettings["sessionCardStyle"]) => {
      void updateSettings({ sessionCardStyle });
    },
    [updateSettings],
  );

  const handleUiBaseSizeChange = useCallback((value: string) => {
    setUiBaseSizeDraft(value.replace(/[^\d]/g, ""));
  }, []);

  const handleCodeSizeChange = useCallback((value: string) => {
    setCodeSizeDraft(value.replace(/[^\d]/g, ""));
  }, []);

  const handleContentSizeChange = useCallback((value: string) => {
    setContentSizeDraft(value.replace(/[^\d]/g, ""));
  }, []);

  const commitUiBaseSize = useCallback(() => {
    const parsed = parseClampedFontSize(uiBaseSizeDraft, {
      min: MIN_UI_BASE_FONT_SIZE,
      max: MAX_UI_BASE_FONT_SIZE,
    });
    const next = parsed ?? settings.uiBaseFontSize;
    setUiBaseSizeDraft(String(next));
    if (next !== settings.uiBaseFontSize) {
      void updateSettings({ uiBaseFontSize: next });
    }
  }, [settings.uiBaseFontSize, uiBaseSizeDraft, updateSettings]);

  const commitCodeSize = useCallback(() => {
    const parsed = parseClampedFontSize(codeSizeDraft, {
      min: MIN_CODE_FONT_SIZE,
      max: MAX_CODE_FONT_SIZE,
    });
    const next = parsed ?? settings.codeFontSize;
    setCodeSizeDraft(String(next));
    if (next !== settings.codeFontSize) {
      void updateSettings({ codeFontSize: next });
    }
  }, [codeSizeDraft, settings.codeFontSize, updateSettings]);

  const commitContentSize = useCallback(() => {
    const parsed = parseClampedFontSize(contentSizeDraft, {
      min: MIN_CONTENT_FONT_SIZE,
      max: MAX_CONTENT_FONT_SIZE,
    });
    const next = parsed ?? settings.contentFontSize;
    setContentSizeDraft(String(next));
    if (next !== settings.contentFontSize) {
      void updateSettings({ contentFontSize: next });
    }
  }, [contentSizeDraft, settings.contentFontSize, updateSettings]);

  const previewOverrides = useMemo(
    () => ({
      contentFontSize: sizeDraftToOverride(contentSizeDraft),
      monoFontFamily: monoFontDraft,
      codeFontSize: sizeDraftToOverride(codeSizeDraft),
      displayFontFamily: displayFontDraft,
    }),
    [codeSizeDraft, contentSizeDraft, monoFontDraft, displayFontDraft],
  );

  return (
    <View>
      <SettingsSection title={t("settings.appearance.theme.title")}>
        <View style={settingsStyles.card}>
          <ThemeRow
            value={settings.theme}
            pluginThemes={pluginThemes}
            selectedPluginTheme={selectedPluginTheme}
            onChange={handleThemeChange}
            onSelectPluginTheme={handlePluginThemeChange}
          />
          <AccentRow value={settings.accentColor} onChange={handleAccentChange} />
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.appearance.detailLevel.title")}>
        <SettingsCard>
          <AutoExpandReasoningRow
            value={settings.autoExpandReasoning}
            onChange={handleAutoExpandReasoningChange}
          />
          <ToolCallDetailRow
            value={settings.toolCallDetailLevel}
            onChange={handleToolCallDetailLevelChange}
          />
          {!isNative ? (
            <ChatOutlineRow
              value={settings.chatOutlineEnabled}
              onChange={handleChatOutlineChange}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
      <SidebarNavSection />
      <SettingsSection title={t("settings.appearance.cards.title")}>
        <View style={settingsStyles.card}>
          <SessionCardStyleRow
            value={settings.sessionCardStyle}
            onChange={handleSessionCardStyleChange}
          />
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.appearance.fonts.title")}>
        <View style={settingsStyles.card}>
          {showInterfaceFontFamilyRow ? (
            <FontFamilyRow
              title={t("settings.appearance.fonts.interfaceFont")}
              hint={t("settings.appearance.fonts.interfaceFontHint")}
              accessibilityLabel={t("settings.appearance.fonts.interfaceFontAccessibility")}
              placeholder={uiFontPlaceholder}
              value={settings.uiFontFamily}
              draft={uiFontDraft}
              withBorder={false}
              onChangeDraft={setUiFontDraft}
              onCommit={commitUiFontFamily}
            />
          ) : null}
          <FontFamilyRow
            title={t("settings.appearance.fonts.displayFont")}
            hint={t("settings.appearance.fonts.displayFontHint")}
            accessibilityLabel={t("settings.appearance.fonts.displayFontAccessibility")}
            placeholder={displayFontPlaceholder}
            value={settings.displayFontFamily}
            draft={displayFontDraft}
            withBorder
            onChangeDraft={setDisplayFontDraft}
            onCommit={commitDisplayFontFamily}
          />
          <FontSizeRow
            title={t("settings.appearance.fonts.interfaceSize")}
            hint={t("settings.appearance.fonts.interfaceSizeHint")}
            accessibilityLabel={t("settings.appearance.fonts.interfaceSizeAccessibility")}
            draft={uiBaseSizeDraft}
            withBorder={showInterfaceFontFamilyRow}
            onChangeDraft={handleUiBaseSizeChange}
            onCommit={commitUiBaseSize}
          />
          <FontSizeRow
            title={t("settings.appearance.fonts.contentSize")}
            hint={t("settings.appearance.fonts.contentSizeHint")}
            accessibilityLabel={t("settings.appearance.fonts.contentSizeAccessibility")}
            draft={contentSizeDraft}
            onChangeDraft={handleContentSizeChange}
            onCommit={commitContentSize}
          />
          <FontFamilyRow
            title={t("settings.appearance.fonts.codeFont")}
            hint={t("settings.appearance.fonts.codeFontHint")}
            accessibilityLabel={t("settings.appearance.fonts.codeFontAccessibility")}
            placeholder={monoFontPlaceholder}
            value={settings.monoFontFamily}
            draft={monoFontDraft}
            withBorder
            onChangeDraft={setMonoFontDraft}
            onCommit={commitMonoFontFamily}
          />
          <FontSizeRow
            title={t("settings.appearance.fonts.codeSize")}
            hint={t("settings.appearance.fonts.codeSizeHint")}
            accessibilityLabel={t("settings.appearance.fonts.codeSizeAccessibility")}
            draft={codeSizeDraft}
            onChangeDraft={handleCodeSizeChange}
            onCommit={commitCodeSize}
          />
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.appearance.syntax.title")}>
        <View style={settingsStyles.card}>
          <SyntaxRow value={settings.syntaxTheme} onChange={handleSyntaxThemeChange} />
        </View>
        <View style={styles.preview}>
          <AppearancePreview overrides={previewOverrides} />
        </View>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  preview: {
    marginTop: theme.spacing[4],
  },
  rowWithBorder: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[1],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: {
    opacity: 0.85,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  accentSwatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  accentRing: {
    padding: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: "transparent",
  },
  accentRingSelected: {
    padding: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.foreground,
  },
  accentFill: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
  },
  accentAuto: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  swatch: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    borderRadius: ICON_SIZE.md / 2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  fontFamilyInput: {
    flexGrow: 1,
    flexShrink: 1,
    maxWidth: 280,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "left",
  },
  sizeField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sizeInput: {
    width: 64,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "right",
  },
  unit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
}));
