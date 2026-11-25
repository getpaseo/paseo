import { useCallback, useMemo, useRef, useState } from "react";
import type { View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { HardDrive } from "lucide-react-native";
import { buildProjectPickerOptions } from "@/components/project-picker-options";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { FieldTrigger } from "@/screens/new-workspace/form/field-trigger";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { shortenPath } from "@/utils/shorten-path";
import { buildSuggestedParentDirectories } from "./options";
import { useDirectorySearch } from "./searches";

const ThemedHardDrive = withUnistyles(HardDrive);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const locationIcon = <ThemedHardDrive size={ICON_SIZE.md} uniProps={mutedColor} />;

interface LocationFieldProps {
  hostId: string | null;
  /** The parent directory the project goes into. */
  location: string;
  /** Where the project ends up, shown on the field so the user rarely needs to open it. */
  destination: string;
  recommendedPaths: string[];
  onChange: (location: string) => void;
  disabled: boolean;
  testID: string;
}

/** Picks the parent directory for a new project: recent parents, a folder search, or a typed path. */
export function LocationField({
  hostId,
  location,
  destination,
  recommendedPaths,
  onChange,
  disabled,
  testID,
}: LocationFieldProps) {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useDirectorySearch({ hostId, query, enabled: open && query.trim().length > 0 });

  // The same builder as the Existing tab: a typed path first, then matching suggestions and
  // folders the host found.
  const pickerOptions = useMemo(() => {
    const suggestions = [
      location,
      ...buildSuggestedParentDirectories(recommendedPaths).filter((path) => path !== location),
    ];
    return buildProjectPickerOptions({
      recommendedPaths: suggestions,
      serverPaths: search.items,
      query,
    });
  }, [location, query, recommendedPaths, search.items]);
  const options = useMemo<ComboboxOption[]>(
    () =>
      pickerOptions.map(
        (option): ComboboxOption => ({
          id: option.path,
          label: shortenPath(option.path),
          description: option.kind === "path" ? "Use this folder" : undefined,
          kind: "directory",
        }),
      ),
    [pickerOptions],
  );
  // Like the Existing tab: while a new search runs, only a typed path is picked for Enter.
  const awaitingOptions = search.pending && pickerOptions[0]?.kind !== "path";

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  }, []);

  return (
    <>
      <FieldTrigger
        ref={anchorRef}
        variant="field"
        label="Location"
        accessibilityLabel="Project location"
        icon={locationIcon}
        value={shortenPath(destination)}
        onPress={handleOpen}
        disabled={disabled}
        testID={testID}
      />
      <Combobox
        options={options}
        value={location}
        onSelect={onChange}
        searchable
        remoteSearch
        remoteSearchPending={awaitingOptions}
        onSearchQueryChange={setQuery}
        searchPlaceholder="Search folders or enter a path"
        emptyText={search.error ?? (search.pending ? "Searching..." : "No matching folders")}
        title="Location"
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
      />
    </>
  );
}
