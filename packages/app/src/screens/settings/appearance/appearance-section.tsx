import { AppearanceText as Text } from "@/appearance/text";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  SYNTAX_THEME_OPTIONS,
  type SyntaxThemeId,
  type SyntaxThemeOption,
} from "@getpaseo/highlight";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { ThemePicker } from "@/appearance/theme-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import {
  MAX_CODE_FONT_SIZE,
  MAX_CONTENT_FONT_SIZE,
  MAX_EXPLORER_SIDEBAR_WIDTH,
  MAX_UI_BASE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_CONTENT_FONT_SIZE,
  MIN_EXPLORER_SIDEBAR_WIDTH,
  MIN_UI_BASE_FONT_SIZE,
  parseClampedInteger,
  sanitizeFontFamily,
  useAppSettings,
  type AppSettings,
  type AppSettingsUpdate,
  type ContentWidthPreset,
} from "@/hooks/use-settings";
import { DEFAULT_MONO_FONT_STACK, DEFAULT_UI_FONT_STACK } from "@/styles/theme";
import { isNative } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
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

interface PixelInputRowProps {
  title: string;
  hint: string;
  accessibilityLabel: string;
  draft: string;
  withBorder?: boolean;
  onChangeDraft: (value: string) => void;
  onCommit: () => string;
}

function PixelInputRow({
  title,
  hint,
  accessibilityLabel,
  draft,
  withBorder = true,
  onChangeDraft,
  onCommit,
}: PixelInputRowProps) {
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
function ContentWidthRow({
  value,
  onChange,
}: {
  value: AppSettings["contentWidth"];
  onChange: (value: ContentWidthPreset) => void;
}) {
  const { t } = useTranslation();

  return (
    <View style={styles.contentWidthRow}>
      <View>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.layout.contentWidth")}</Text>
        <Text style={settingsStyles.rowHint}>
          {typeof value === "number"
            ? t("settings.appearance.layout.contentWidthCustom", { width: value })
            : t("settings.appearance.layout.contentWidthHint")}
        </Text>
      </View>
      <SegmentedControl<ContentWidthPreset>
        testID="content-width-options"
        value={typeof value === "number" ? null : value}
        onValueChange={onChange}
        options={[
          { value: "default", label: t("settings.appearance.layout.contentWidthDefault") },
          { value: "wide", label: t("settings.appearance.layout.contentWidthWide") },
          { value: "full", label: t("settings.appearance.layout.contentWidthFull") },
        ]}
      />
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

type PixelSetting = "uiBaseFontSize" | "contentFontSize" | "codeFontSize" | "explorerSidebarWidth";

function usePixelSettingDraft(key: PixelSetting, min: number, max: number) {
  const { settings, updateSettings } = useAppSettings();
  const value = settings[key];
  const [draft, setDraft] = useState(String(value));

  // Resync when the committed value changes elsewhere.
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const onChangeDraft = useCallback((text: string) => {
    setDraft(text.replace(/[^\d]/g, ""));
  }, []);

  const onCommit = useCallback(() => {
    const next = parseClampedInteger(draft, { min, max }) ?? value;
    setDraft(String(next));
    if (next !== value) {
      const update: AppSettingsUpdate = { [key]: next };
      void updateSettings(update);
    }
    return String(next);
  }, [draft, key, max, min, updateSettings, value]);

  return { draft, onChangeDraft, onCommit };
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
  const uiBaseSize = usePixelSettingDraft(
    "uiBaseFontSize",
    MIN_UI_BASE_FONT_SIZE,
    MAX_UI_BASE_FONT_SIZE,
  );
  const contentSize = usePixelSettingDraft(
    "contentFontSize",
    MIN_CONTENT_FONT_SIZE,
    MAX_CONTENT_FONT_SIZE,
  );
  const codeSize = usePixelSettingDraft("codeFontSize", MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE);
  const explorerWidth = usePixelSettingDraft(
    "explorerSidebarWidth",
    MIN_EXPLORER_SIDEBAR_WIDTH,
    MAX_EXPLORER_SIDEBAR_WIDTH,
  );

  const handleContentWidthChange = useCallback(
    (contentWidth: ContentWidthPreset) => {
      void updateSettings({ contentWidth });
    },
    [updateSettings],
  );

  const handleSyntaxThemeChange = useCallback(
    (syntaxTheme: SyntaxThemeId) => {
      void updateSettings({ syntaxTheme });
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

  // Live-while-typing: the in-progress drafts drive the preview without
  // committing to the global theme. Empty/invalid fields fall back to the
  // theme value inside the preview.
  const previewOverrides = useMemo(
    () => ({
      contentFontSize: sizeDraftToOverride(contentSize.draft),
      monoFontFamily: monoFontDraft,
      codeFontSize: sizeDraftToOverride(codeSize.draft),
    }),
    [codeSize.draft, contentSize.draft, monoFontDraft],
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
          <PixelInputRow
            title={t("settings.appearance.fonts.interfaceSize")}
            hint={t("settings.appearance.fonts.interfaceSizeHint")}
            accessibilityLabel={t("settings.appearance.fonts.interfaceSizeAccessibility")}
            draft={uiBaseSize.draft}
            withBorder={showInterfaceFontFamilyRow}
            onChangeDraft={uiBaseSize.onChangeDraft}
            onCommit={uiBaseSize.onCommit}
          />
          <PixelInputRow
            title={t("settings.appearance.fonts.contentSize")}
            hint={t("settings.appearance.fonts.contentSizeHint")}
            accessibilityLabel={t("settings.appearance.fonts.contentSizeAccessibility")}
            draft={contentSize.draft}
            onChangeDraft={contentSize.onChangeDraft}
            onCommit={contentSize.onCommit}
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
          <PixelInputRow
            title={t("settings.appearance.fonts.codeSize")}
            hint={t("settings.appearance.fonts.codeSizeHint")}
            accessibilityLabel={t("settings.appearance.fonts.codeSizeAccessibility")}
            draft={codeSize.draft}
            onChangeDraft={codeSize.onChangeDraft}
            onCommit={codeSize.onCommit}
          />
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.appearance.layout.title")}>
        <View style={settingsStyles.card}>
          <ContentWidthRow value={settings.contentWidth} onChange={handleContentWidthChange} />
          <PixelInputRow
            title={t("settings.appearance.layout.explorerWidth")}
            hint={t("settings.appearance.layout.explorerWidthHint")}
            accessibilityLabel={t("settings.appearance.layout.explorerWidthAccessibility")}
            draft={explorerWidth.draft}
            onChangeDraft={explorerWidth.onChangeDraft}
            onCommit={explorerWidth.onCommit}
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
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  themeCard: {
    padding: theme.spacing[3],
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
  contentWidthRow: {
    alignItems: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  unit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
}));
