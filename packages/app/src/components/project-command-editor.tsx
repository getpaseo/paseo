import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Switch, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PASEO_PLATFORMS, type PaseoPlatform } from "@getpaseo/protocol/paseo-config-schema";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import {
  changeCommandFormat,
  type CommandDraft,
  type CommandFormat,
} from "@/utils/project-config-form";

export interface ProjectCommandEditorProps {
  command: CommandDraft;
  onChange: (command: CommandDraft) => void;
  variant: "settings" | "modal";
  inputTestID: string;
  platformTestIDPrefix: string;
  formatTestID: string;
  accessibilityLabel: string;
  placeholder: string;
  onBlur?: () => void;
  errorMessage?: string | null;
  errorTestID?: string;
}

export function ProjectCommandEditor({
  command,
  onChange,
  variant,
  inputTestID,
  platformTestIDPrefix,
  formatTestID,
  accessibilityLabel,
  placeholder,
  onBlur,
  errorMessage,
  errorTestID,
}: ProjectCommandEditorProps) {
  const handleTextChange = useCallback(
    (text: string) => onChange({ ...command, text }),
    [command, onChange],
  );
  const handleFormatChange = useCallback(
    (format: CommandFormat) => onChange(changeCommandFormat(command, format)),
    [command, onChange],
  );
  const handlePlatformChange = useCallback(
    (platform: PaseoPlatform, text: string) =>
      onChange({
        ...command,
        platforms: {
          ...command.platforms,
          [platform]: { ...command.platforms[platform], text },
        },
      }),
    [command, onChange],
  );

  return (
    <>
      {command.format === "single" ? (
        <SingleCommandInput
          variant={variant}
          testID={inputTestID}
          accessibilityLabel={accessibilityLabel}
          value={command.text}
          onChangeText={handleTextChange}
          onBlur={onBlur}
          placeholder={placeholder}
        />
      ) : (
        <PlatformCommandInputs
          command={command}
          variant={variant}
          testIDPrefix={platformTestIDPrefix}
          onChange={handlePlatformChange}
          placeholder={placeholder}
        />
      )}
      {errorMessage ? (
        <Text testID={errorTestID} style={styles.fieldError}>
          {errorMessage}
        </Text>
      ) : null}
      <CommandFormatToggle
        format={command.format}
        onChange={handleFormatChange}
        accessibilityLabel={accessibilityLabel}
        testID={formatTestID}
      />
    </>
  );
}

interface SingleCommandInputProps {
  variant: "settings" | "modal";
  testID: string;
  accessibilityLabel: string;
  value: string;
  onChangeText: (text: string) => void;
  onBlur?: () => void;
  placeholder: string;
}

function SingleCommandInput({
  variant,
  testID,
  accessibilityLabel,
  value,
  onChangeText,
  onBlur,
  placeholder,
}: SingleCommandInputProps) {
  if (variant === "settings") {
    return (
      <SettingsTextAreaCard
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
      />
    );
  }

  return (
    <TextInput
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      multiline
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      placeholder={placeholder}
      placeholderTextColor={styles.placeholderColor.color}
      style={styles.modalMultilineInput}
    />
  );
}

interface PlatformCommandInputsProps {
  command: CommandDraft;
  variant: "settings" | "modal";
  testIDPrefix: string;
  onChange: (platform: PaseoPlatform, text: string) => void;
  placeholder: string;
}

function PlatformCommandInputs({
  command,
  variant,
  testIDPrefix,
  onChange,
  placeholder,
}: PlatformCommandInputsProps) {
  return (
    <View style={styles.platformFields}>
      {PASEO_PLATFORMS.map((platform) => (
        <View key={platform} style={styles.platformField}>
          <Text style={styles.modalLabel}>{formatPlatformLabel(platform)}</Text>
          <PlatformCommandInput
            variant={variant}
            platform={platform}
            testID={`${testIDPrefix}-${platform}`}
            accessibilityLabel={`${formatPlatformLabel(platform)} command`}
            value={command.platforms[platform].text}
            onChange={onChange}
            placeholder={placeholder}
          />
        </View>
      ))}
    </View>
  );
}

interface PlatformCommandInputProps {
  variant: "settings" | "modal";
  platform: PaseoPlatform;
  testID: string;
  accessibilityLabel: string;
  value: string;
  onChange: (platform: PaseoPlatform, text: string) => void;
  placeholder: string;
}

function PlatformCommandInput({
  variant,
  platform,
  testID,
  accessibilityLabel,
  value,
  onChange,
  placeholder,
}: PlatformCommandInputProps) {
  const handleChange = useCallback(
    (text: string) => onChange(platform, text),
    [onChange, platform],
  );

  if (variant === "settings") {
    return (
      <SettingsTextAreaCard
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        value={value}
        onChangeText={handleChange}
        placeholder={placeholder}
      />
    );
  }

  return (
    <TextInput
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      multiline
      value={value}
      onChangeText={handleChange}
      placeholder={placeholder}
      placeholderTextColor={styles.placeholderColor.color}
      style={styles.modalMultilineInput}
    />
  );
}

interface CommandFormatToggleProps {
  format: CommandFormat;
  onChange: (format: CommandFormat) => void;
  accessibilityLabel: string;
  testID: string;
}

function CommandFormatToggle({
  format,
  onChange,
  accessibilityLabel,
  testID,
}: CommandFormatToggleProps) {
  const { t } = useTranslation();
  const isPlatform = format === "platform";
  const handleChange = useCallback(
    (next: boolean) => onChange(next ? "platform" : "single"),
    [onChange],
  );

  return (
    <View style={styles.formatToggleRow}>
      <Text style={styles.modalHint}>
        {isPlatform
          ? t("settings.project.commandFormat.platform")
          : t("settings.project.commandFormat.single")}
      </Text>
      <Switch
        value={isPlatform}
        onValueChange={handleChange}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      />
    </View>
  );
}

export function formatPlatformLabel(platform: PaseoPlatform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return "Linux";
}

const styles = StyleSheet.create((theme) => ({
  formatToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  platformFields: {
    gap: theme.spacing[3],
  },
  platformField: {
    gap: theme.spacing[2],
  },
  modalLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  modalMultilineInput: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    minHeight: 100,
    textAlignVertical: "top",
  },
  modalHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  fieldError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
}));
