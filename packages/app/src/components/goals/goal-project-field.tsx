import { useCallback, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Folder, FolderOpen } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import { ComboboxItem } from "@/components/ui/combobox";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { getIsElectronRuntime } from "@/constants/layout";
import { pickDirectory } from "@/desktop/pick-directory";
import type { GoalFormModel, GoalFormState } from "@/goals/goal-form-model";
import type { GoalCwdCheck } from "@/goals/goal-projects";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import type { Theme } from "@/styles/theme";
import { shortenPath } from "@/utils/shorten-path";

const OTHER_FOLDER = "__other_folder__";

const ThemedFolder = withUnistyles(Folder);
const ThemedFolderOpen = withUnistyles(FolderOpen);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The host the goal runs on; shown only when more than one connected host runs goals. */
export function GoalHostField({
  model,
  state,
  size,
}: {
  model: GoalFormModel;
  state: GoalFormState;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: `goal-host-option-${host.serverId}`,
      })),
    [state.hosts],
  );
  const selectedLabel =
    state.hosts.find((host) => host.serverId === state.serverId)?.label ?? state.serverId;
  const selectedDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: selectedLabel }),
    [selectedLabel],
  );
  const triggerLeading = useMemo(
    () => <HostStatusDotSlot serverId={state.serverId} />,
    [state.serverId],
  );
  const renderOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <HostOptionItem {...input} />,
    [],
  );
  return (
    <SelectField
      label={t("goals.form.hostLabel")}
      value={state.serverId}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={model.setHost}
      placeholder={t("goals.form.hostLabel")}
      emptyText={t("goals.form.hostLabel")}
      searchable={false}
      title={t("goals.form.hostLabel")}
      size={size}
      testID="goal-host"
      triggerTestID="goal-host-trigger"
      triggerLeading={triggerLeading}
      renderOption={renderOption}
    />
  );
}

function HostOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(() => <HostStatusDotSlot serverId={option.value} />, [option.value]);
  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

/** What the goal will build from, or that the host is still checking the folder. */
function cwdStatusText(t: TFunction, check: GoalCwdCheck | null, cwd: string): string | null {
  if (!check || check.cwd !== cwd.trim() || check.status === "notGit") {
    return null;
  }
  if (check.status === "checking") {
    return t("goals.form.cwdCheck.checking");
  }
  const from = check.branch
    ? t("goals.form.cwdCheck.branch", { branch: check.branch })
    : t("goals.form.cwdCheck.detached");
  return check.dirty ? `${from} · ${t("goals.form.cwdCheck.dirty")}` : from;
}

/**
 * The project the goal works on: the host's git projects, most recently used first, and a way
 * to choose another folder (the desktop folder dialog for this computer's daemon, a typed path
 * otherwise). The directory and what it builds from stay visible under the picker.
 */
export function GoalProjectField({
  model,
  state,
  size,
  error,
}: {
  model: GoalFormModel;
  state: GoalFormState;
  size: FieldControlSize;
  error: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const localServerId = useLocalDaemonServerId();
  const canBrowse = getIsElectronRuntime() && localServerId === state.serverId;
  const options = useMemo<SelectFieldOption<string>[]>(
    () => [
      ...state.projectOptions.map((project) => ({
        id: project.projectId,
        value: project.projectId,
        label: project.name,
        description: shortenPath(project.rootPath),
        testID: `goal-project-option-${project.projectId}`,
      })),
      {
        id: OTHER_FOLDER,
        value: OTHER_FOLDER,
        label: t("goals.form.otherFolder"),
        testID: "goal-project-other",
      },
    ],
    [state.projectOptions, t],
  );
  const status = cwdStatusText(t, state.cwdCheck, state.values.cwd);
  const display = state.projectDisplay;
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (!display) {
      return null;
    }
    const path = shortenPath(display.path);
    return { label: display.label, description: status ? `${path} · ${status}` : path };
  }, [display, status]);

  const browse = useCallback(async () => {
    try {
      const path = await pickDirectory();
      if (path) {
        model.chooseFolder(path);
      }
    } catch {
      model.setFolderInputVisible(true);
    }
  }, [model]);

  const handleChange = useCallback(
    (value: string) => {
      if (value !== OTHER_FOLDER) {
        model.chooseProject(value);
        return;
      }
      if (canBrowse) {
        void browse();
        return;
      }
      model.setFolderInputVisible(true);
    },
    [browse, canBrowse, model],
  );
  const setCwd = useCallback((value: string) => model.setValue("cwd", value), [model]);
  const renderOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ProjectOptionItem {...input} />,
    [],
  );

  return (
    <>
      <SelectField
        label={t("goals.form.projectLabel")}
        value={state.selectedProjectId}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={handleChange}
        placeholder={t("goals.form.projectPlaceholder")}
        emptyText={t("goals.form.projectEmpty")}
        error={error}
        searchable={options.length > 6}
        searchPlaceholder={t("goals.form.projectSearch")}
        title={t("goals.form.projectLabel")}
        size={size}
        testID="goal-project"
        triggerTestID="goal-project-trigger"
        renderOption={renderOption}
      />
      {state.folderInputVisible ? (
        <Field label={t("goals.form.cwdLabel")}>
          <FormTextInput
            key={state.serverId}
            size={size}
            testID="goal-cwd-input"
            accessibilityLabel={t("goals.form.cwdLabel")}
            initialValue={state.values.cwd}
            onChangeText={setCwd}
            placeholder={t("goals.form.cwdPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      ) : null}
    </>
  );
}

function ProjectOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const isOther = option.value === OTHER_FOLDER;
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {isOther ? (
          <ThemedFolderOpen size={16} uniProps={mutedColorMapping} />
        ) : (
          <ThemedFolder size={16} uniProps={mutedColorMapping} />
        )}
      </View>
    ),
    [isOther],
  );
  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      description={option.description}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

const styles = StyleSheet.create(() => ({
  optionIconBox: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
}));
