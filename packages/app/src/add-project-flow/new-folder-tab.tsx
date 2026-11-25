import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { isWeb } from "@/constants/platform";
import type { AddProjectActions } from "./use-add-project-actions";
import type { AddProjectFlowState, AddProjectHost } from "./model";
import { LocationField } from "./location-field";
import { joinDirectoryPath, validateNewFolderName } from "./options";
import type { AddProjectTabView } from "./tab-view";

export interface NewFolderTabView extends AddProjectTabView {
  location: string;
  destination: string;
  /** Why the typed name cannot be a folder; null while empty or valid. */
  nameError: string | null;
}

export function useNewFolderTab(input: {
  state: AddProjectFlowState;
  host: AddProjectHost | null;
  defaultLocation: string;
  actions: AddProjectActions;
}): NewFolderTabView {
  const { state, host, defaultLocation, actions } = input;
  const { name } = state.newFolder;
  const location = state.newFolder.location ?? defaultLocation;
  const trimmed = name.trim();
  const nameError = trimmed ? validateNewFolderName(name) : null;
  // Preview and create only a name that can be created, so the field never shows a path that
  // escapes the location.
  const previewName = trimmed && !nameError ? trimmed : null;
  const canCreate = host?.canCreateDirectory === true;

  return useMemo<NewFolderTabView>(
    () => ({
      rows: [],
      activeIndex: 0,
      notice: null,
      location,
      destination: previewName ? joinDirectoryPath(location, previewName) : location,
      unavailable: canCreate ? null : "Update the host to create folders",
      nameError,
      primary: {
        label: "Create project",
        submit: canCreate && previewName ? () => actions.createFolder(name, location) : null,
      },
    }),
    [actions, canCreate, location, name, nameError, previewName],
  );
}

export function NewFolderTab({
  view,
  name,
  hostId,
  recommendedPaths,
  disabled,
  autoFocus,
  onNameChange,
  onLocationChange,
}: {
  view: NewFolderTabView;
  name: string;
  hostId: string | null;
  recommendedPaths: string[];
  disabled: boolean;
  /** Focus the field on mount; only with a hardware keyboard, so touch keeps the list in view. */
  autoFocus: boolean;
  onNameChange: (name: string) => void;
  onLocationChange: (location: string) => void;
}) {
  const editable = !disabled && !view.unavailable;
  return (
    <View style={styles.body}>
      <Field
        label="Name"
        hint={view.unavailable ?? undefined}
        error={view.nameError}
        testID="add-project-flow-name-field"
      >
        <FormTextInput
          initialValue={name}
          onChangeText={onNameChange}
          onSubmitEditing={isWeb ? undefined : (view.primary.submit ?? undefined)}
          placeholder="my-project"
          accessibilityLabel="Folder name"
          autoFocus={autoFocus}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          editable={editable}
          invalid={Boolean(view.nameError)}
          testID="add-project-flow-input"
        />
      </Field>
      <LocationField
        hostId={hostId}
        location={view.location}
        destination={view.destination}
        recommendedPaths={recommendedPaths}
        onChange={onLocationChange}
        disabled={!editable}
        testID="add-project-flow-location"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
  },
}));
