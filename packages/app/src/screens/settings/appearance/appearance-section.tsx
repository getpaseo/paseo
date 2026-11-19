import { AppearanceText as Text } from "@/appearance/text";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet, UnistylesRuntime, withUnistyles } from "react-native-unistyles";
import {
  SYNTAX_THEME_OPTIONS,
  type SyntaxThemeId,
  type SyntaxThemeOption,
} from "@getpaseo/highlight";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { ThemePicker } from "@/appearance/theme-picker";
import { ThemePreview, ThemePreviewFrame } from "@/appearance/theme-preview";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import {
  MAX_CODE_FONT_SIZE,
  MAX_CONTENT_FONT_SIZE,
  MAX_UI_BASE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_CONTENT_FONT_SIZE,
  MIN_UI_BASE_FONT_SIZE,
  parseClampedFontSize,
  parseContentMaxWidth,
  resolveContentMaxWidth,
  sanitizeFontFamily,
  useAppSettings,
  type AppSettings,
} from "@/hooks/use-settings";
import {
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  resolveTerminalTheme,
  TERMINAL_THEME_PREFERENCES,
  type TerminalThemePreference,
} from "@/styles/theme";
import { isNative } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { AppearancePreview } from "./appearance-preview";

// Subscribe the input leaf to numeric theme changes without resetting its editing state.
const TextInput = withUnistyles(EditingTextInput, (theme) => {
  void theme.fontSize;
  return {};
});
// Platform default stacks can be the bare native tokens ("normal"/"monospace");
// those read as a bug, so show a human label in the placeholder instead.
const BARE_DEFAULT_STACKS: ReadonlySet<string> = new Set(["normal", "monospace"]);

function resolveDefaultStackPlaceholder(t: TFunction, stack: string): string {
  return BARE_DEFAULT_STACKS.has(stack) ? t("settings.appearance.fonts.systemDefault") : stack;
}

// Local size string (digits only) -> preview override number. Empty/invalid
// yields undefined so the preview falls back to the committed theme value.
function sizeDraftToOverride(value: string): number | undefined {
  if (value.length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Fonts: family text fields + numeric size fields (commit on blur/submit)
// ---------------------------------------------------------------------------

interface FontFamilyRowProps {
  title: string;
  hint: string;
  accessibilityLabel: string;
  placeholder: string;
  value: string;
  draft: string;
  withBorder: boolean;
  onChangeDraft: (value: string) => void;
  onCommit: (value: string) => string;
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
  const inputRef = useRef<EditingTextInputHandle>(null);
  const handleCommit = useCallback(() => {
    const committed = onCommit(draft);
    inputRef.current?.replaceText(committed);
  }, [draft, onCommit]);

  // Resync from the committed value when it changes elsewhere.
  useEffect(() => {
    onChangeDraft(value);
    inputRef.current?.replaceText(value);
    // Only resync on external value changes, not on local keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <TextInput
        ref={inputRef}
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
  onCommit: () => string;
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
  const inputRef = useRef<EditingTextInputHandle>(null);
  const handleCommit = useCallback(() => {
    const committed = onCommit();
    inputRef.current?.replaceText(committed);
  }, [onCommit]);

  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <View style={styles.sizeField}>
        <TextInput
          ref={inputRef}
          initialValue={draft}
          onChangeText={onChangeDraft}
          onBlur={handleCommit}
          onSubmitEditing={handleCommit}
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

// ---------------------------------------------------------------------------
// Content width: numeric field (commit on blur/submit) + reset to the default
// ---------------------------------------------------------------------------

interface ContentWidthRowProps {
  value: AppSettings["contentMaxWidth"];
  onChange: (value: AppSettings["contentMaxWidth"]) => void;
}

function ContentWidthRow({ value, onChange }: ContentWidthRowProps) {
  const { t } = useTranslation();
  const width = resolveContentMaxWidth({ contentMaxWidth: value });
  // The field is uncontrolled, so a saved or reset width is written into it directly.
  const input = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    input.current?.replaceText(String(width));
  }, [width]);

  const commit = useCallback(() => {
    const next = parseContentMaxWidth(input.current?.getText()) ?? width;
    input.current?.replaceText(String(next));
    // Typing the width already in effect keeps following the default.
    if (next !== width) {
      onChange(next);
    }
  }, [onChange, width]);

  const reset = useCallback(() => {
    onChange(null);
  }, [onChange]);

  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.layout.contentWidth")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.layout.contentWidthHint")}
        </Text>
      </View>
      <View style={styles.sizeField}>
        {value === null ? null : (
          <Button
            variant="ghost"
            onPress={reset}
            accessibilityLabel={t("settings.appearance.layout.resetAccessibility")}
          >
            {t("settings.appearance.layout.reset")}
          </Button>
        )}
        <TextInput
          ref={input}
          initialValue={String(width)}
          onBlur={commit}
          onSubmitEditing={commit}
          keyboardType="number-pad"
          inputMode="numeric"
          selectTextOnFocus
          style={styles.widthInput}
          accessibilityLabel={t("settings.appearance.layout.contentWidthAccessibility")}
        />
        <Text style={styles.unit}>px</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Syntax highlight theme picker (commits immediately)
// ---------------------------------------------------------------------------

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
        <DropdownTrigger
          accessibilityLabel={t("settings.appearance.syntax.highlightThemeAccessibility", {
            value: selectedLabel,
          })}
        >
          {selectedLabel}
        </DropdownTrigger>
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

function terminalThemeLabel(t: TFunction, value: TerminalThemePreference): string {
  if (value === "match") return t("settings.appearance.terminal.matchApp");
  return t(`settings.appearance.theme.options.${value}`);
}

function TerminalThemeMenuItem({
  option,
  selected,
  activeTheme,
  onChange,
}: {
  option: TerminalThemePreference;
  selected: boolean;
  activeTheme: Theme;
  onChange: (value: TerminalThemePreference) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(option), [onChange, option]);
  const previewTheme = resolveTerminalTheme(option, activeTheme);
  const preview = useMemo(
    () => (
      <ThemePreviewFrame>
        <ThemePreview theme={previewTheme} />
      </ThemePreviewFrame>
    ),
    [previewTheme],
  );
  return (
    <View style={styles.terminalMenuCell}>
      <DropdownMenuItem
        stacked
        selected={selected}
        onSelect={handleSelect}
        leading={preview}
        leadingStyle={styles.terminalMenuPreview}
        style={[styles.terminalMenuItem, selected ? styles.terminalMenuItemSelected : null]}
      >
        {terminalThemeLabel(t, option)}
      </DropdownMenuItem>
    </View>
  );
}

function TerminalThemeRow({
  value,
  onChange,
}: {
  value: TerminalThemePreference;
  onChange: (value: TerminalThemePreference) => void;
}) {
  const { t } = useTranslation();
  const activeTheme = UnistylesRuntime.getTheme();
  const selectedLabel = terminalThemeLabel(t, value);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.terminal.title")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.appearance.terminal.hint")}</Text>
      </View>
      <DropdownMenu>
        <DropdownTrigger
          accessibilityLabel={t("settings.appearance.terminal.themeAccessibility", {
            value: selectedLabel,
          })}
        >
          {selectedLabel}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={420}>
          <View style={styles.terminalMenuGrid}>
            {TERMINAL_THEME_PREFERENCES.map((option) => (
              <TerminalThemeMenuItem
                key={option}
                option={option}
                selected={value === option}
                activeTheme={activeTheme}
                onChange={onChange}
              />
            ))}
          </View>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const showInterfaceFontFamilyRow = !isNative;
  const uiFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_UI_FONT_STACK);
  const monoFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_MONO_FONT_STACK);

  const [uiFontDraft, setUiFontDraft] = useState(settings.uiFontFamily);
  const [monoFontDraft, setMonoFontDraft] = useState(settings.monoFontFamily);
  const [uiBaseSizeDraft, setUiBaseSizeDraft] = useState(String(settings.uiBaseFontSize));
  const [contentSizeDraft, setContentSizeDraft] = useState(String(settings.contentFontSize));
  const [codeSizeDraft, setCodeSizeDraft] = useState(String(settings.codeFontSize));

  // Resync numeric drafts when the committed value changes elsewhere.
  useEffect(() => {
    setUiBaseSizeDraft(String(settings.uiBaseFontSize));
  }, [settings.uiBaseFontSize]);
  useEffect(() => {
    setContentSizeDraft(String(settings.contentFontSize));
  }, [settings.contentFontSize]);
  useEffect(() => {
    setCodeSizeDraft(String(settings.codeFontSize));
  }, [settings.codeFontSize]);

  const handleContentMaxWidthChange = useCallback(
    (contentMaxWidth: AppSettings["contentMaxWidth"]) => {
      void updateSettings({ contentMaxWidth });
    },
    [updateSettings],
  );

  const handleSyntaxThemeChange = useCallback(
    (syntaxTheme: SyntaxThemeId) => {
      void updateSettings({ syntaxTheme });
    },
    [updateSettings],
  );

  const handleTerminalThemeChange = useCallback(
    (terminalTheme: TerminalThemePreference) => {
      void updateSettings({ terminalTheme });
    },
    [updateSettings],
  );

  const commitUiFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setUiFontDraft(settings.uiFontFamily);
        return settings.uiFontFamily;
      }
      setUiFontDraft(sanitized);
      if (sanitized !== settings.uiFontFamily) {
        void updateSettings({ uiFontFamily: sanitized });
      }
      return sanitized;
    },
    [settings.uiFontFamily, updateSettings],
  );

  const commitMonoFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setMonoFontDraft(settings.monoFontFamily);
        return settings.monoFontFamily;
      }
      setMonoFontDraft(sanitized);
      if (sanitized !== settings.monoFontFamily) {
        void updateSettings({ monoFontFamily: sanitized });
      }
      return sanitized;
    },
    [settings.monoFontFamily, updateSettings],
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
    return String(next);
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
    return String(next);
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
    return String(next);
  }, [contentSizeDraft, settings.contentFontSize, updateSettings]);

  // Live-while-typing: the in-progress drafts drive the preview without
  // committing to the global theme. Empty/invalid fields fall back to the
  // theme value inside the preview.
  const previewOverrides = useMemo(
    () => ({
      contentFontSize: sizeDraftToOverride(contentSizeDraft),
      monoFontFamily: monoFontDraft,
      codeFontSize: sizeDraftToOverride(codeSizeDraft),
    }),
    [codeSizeDraft, contentSizeDraft, monoFontDraft],
  );

  return (
    <View>
      <SettingsSection title={t("settings.appearance.theme.title")}>
        <View style={[settingsStyles.card, styles.themeCard]}>
          <ThemePicker />
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
      <SettingsSection title={t("settings.appearance.layout.title")}>
        <View style={settingsStyles.card}>
          <ContentWidthRow
            value={settings.contentMaxWidth}
            onChange={handleContentMaxWidthChange}
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
      <SettingsSection title={t("settings.appearance.terminal.sectionTitle")}>
        <View style={settingsStyles.card}>
          <TerminalThemeRow value={settings.terminalTheme} onChange={handleTerminalThemeChange} />
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
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  themeCard: {
    padding: theme.spacing[3],
  },
  terminalMenuPreview: {
    width: "90%",
    alignSelf: "center",
  },
  terminalMenuGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    margin: -theme.spacing[3] / 2,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  terminalMenuCell: {
    width: { xs: "100%", md: "50%", lg: "33.3333%" },
    padding: theme.spacing[3] / 2,
  },
  terminalMenuItem: {
    width: "100%",
    marginHorizontal: 0,
    backgroundColor: "transparent",
    padding: theme.spacing[1],
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[2],
  },
  terminalMenuItemSelected: {
    borderColor: theme.colors.accent,
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
  widthInput: {
    width: 80,
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
