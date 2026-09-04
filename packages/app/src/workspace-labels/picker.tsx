import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import {
  normalizeWorkspaceLabelName,
  WORKSPACE_LABEL_COLORS,
  type WorkspaceLabelColor,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import {
  MenuHint,
  MenuItem,
  MenuSeparator,
  MenuSubTrigger,
  MenuTextField,
  menuRowContentInset,
  useMenuContext,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import {
  createWorkspaceLabelPickerModel,
  useWorkspaceLabelProjection,
  workspaceLabelErrorMessage,
  workspaceLabels,
  type WorkspaceLabelPickerRow,
} from "@/workspace-labels";
import type { Theme } from "@/styles/theme";
import { WorkspaceLabelDot, WorkspaceLabelSwatchRow } from "./swatch";

/** The `MenuSubTrigger` on a workspace's menu that opens the assign page. */
export const WORKSPACE_LABEL_PAGE_ID = "workspaceLabels";
const WORKSPACE_LABEL_CREATE_PAGE_ID = "workspaceLabelsCreate";

/** The menu's own icon size, matching the trailing check on every other row. */
const MENU_ICON_SIZE = 14;

const ThemedPlus = withUnistyles(Plus);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// The create row keeps the leading column the label rows above it sit in. Without a mark there
// its label would start on the text rail while every label starts 24pt further in, and the last
// row of the page would read as one that slipped out of the list.
const CREATE_LEADING = <ThemedPlus size={MENU_ICON_SIZE} uniProps={mutedMapping} />;

/** The colour a new label takes until you say otherwise. */
const DEFAULT_CREATE_COLOR: WorkspaceLabelColor = WORKSPACE_LABEL_COLORS[0];

export interface WorkspaceLabelTarget {
  serverId: string;
  workspaceId: string;
  /** Label names the workspace already carries, from the sidebar entry. */
  labels: readonly string[];
}

const NO_PAGES: readonly MenuPageDefinition[] = [];

/**
 * The two pages behind a workspace's `Labels` row, for whichever menu is asking.
 *
 * Both the kebab dropdown and the row's context menu open the same thing, and a page defined
 * twice is a page that will be improved once.
 */
export function useWorkspaceLabelMenuPages(
  target: WorkspaceLabelTarget | null,
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  return useMemo(() => {
    if (!target) return NO_PAGES;
    return [
      {
        id: WORKSPACE_LABEL_PAGE_ID,
        title: t("workspaceLabels.title"),
        content: (
          <WorkspaceLabelPickerPage
            serverId={target.serverId}
            workspaceId={target.workspaceId}
            assignedLabels={target.labels}
          />
        ),
      },
      {
        id: WORKSPACE_LABEL_CREATE_PAGE_ID,
        title: t("workspaceLabels.create"),
        // A page you type into is not one the pointer opens or dismisses on its own.
        hoverIntent: false,
        content: (
          <WorkspaceLabelCreatePage serverId={target.serverId} workspaceId={target.workspaceId} />
        ),
      },
    ];
  }, [t, target]);
}

/**
 * Every label on the host, with the ones this workspace carries ticked.
 *
 * Assigning is multi-select, so a press toggles and nothing closes; the menu ends when it is
 * dismissed. Assignment is the trailing check `MenuItem` already draws for a chosen row, and the
 * colour goes in the leading slot, which puts both on the rails every other row in the menu uses.
 */
function WorkspaceLabelPickerPage({
  serverId,
  workspaceId,
  assignedLabels,
}: {
  serverId: string;
  workspaceId: string;
  assignedLabels: readonly string[];
}): ReactElement {
  const { t } = useTranslation();
  const { labels, targetHost: host } = useWorkspaceLabelProjection(serverId);
  const model = useMemo(
    () =>
      createWorkspaceLabelPickerModel({
        mutate: ({ label, assigned }) =>
          workspaceLabels.setAssignment({ serverId, workspaceId, label, assigned }),
      }),
    [serverId, workspaceId],
  );
  useEffect(() => {
    model.sync({ labels, assigned: assignedLabels, online: host?.status === "online" });
  }, [assignedLabels, host?.status, labels, model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const offline = !snapshot.online;
  const pending = useMemo(() => new Set(snapshot.pendingNames), [snapshot.pendingNames]);
  const toggle = useCallback(
    (label: WorkspaceLabelDefinition, assigned: boolean) => {
      void model.toggle(label, assigned);
    },
    [model],
  );

  return (
    <>
      {snapshot.rows.map((row) => (
        <WorkspaceLabelAssignRow
          key={row.name.toLocaleLowerCase()}
          row={row}
          offline={offline}
          pending={pending.has(row.name.toLocaleLowerCase())}
          onToggle={toggle}
        />
      ))}
      {snapshot.rows.length > 0 ? <MenuSeparator /> : null}
      <MenuSubTrigger
        id={WORKSPACE_LABEL_CREATE_PAGE_ID}
        leading={CREATE_LEADING}
        disabled={offline}
        testID="workspace-label-picker-create"
      >
        {t("workspaceLabels.create")}
      </MenuSubTrigger>
      {snapshot.error ? (
        <MenuHint testID="workspace-label-picker-error">{snapshot.error}</MenuHint>
      ) : null}
      {host?.status === "unsupported" ? (
        <MenuHint>{t("workspaceLabels.updateHostUse")}</MenuHint>
      ) : null}
    </>
  );
}

function WorkspaceLabelAssignRow({
  row,
  offline,
  pending,
  onToggle,
}: {
  row: WorkspaceLabelPickerRow;
  offline: boolean;
  pending: boolean;
  onToggle: (label: WorkspaceLabelDefinition, assigned: boolean) => void;
}): ReactElement {
  const leading = useMemo(() => <WorkspaceLabelDot color={row.color} />, [row.color]);
  const select = useCallback(
    () => onToggle({ name: row.name, color: row.color }, !row.assigned),
    [onToggle, row.assigned, row.color, row.name],
  );
  return (
    <MenuItem
      leading={leading}
      selected={row.assigned}
      disabled={offline}
      status={pending ? "pending" : "idle"}
      closeOnSelect={false}
      onSelect={select}
      testID={`workspace-label-picker-row-${row.name}`}
    >
      {row.name}
    </MenuItem>
  );
}

/**
 * Naming a new label and giving it a colour, in place of the list rather than under it.
 *
 * Picking a colour picks a colour: the label is created by the one row that says so, and only
 * once the name is not empty. A failure keeps the draft and says what happened, because the
 * alternative is retyping the name to find out whether the host is still there.
 */
function WorkspaceLabelCreatePage({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}): ReactElement {
  const { t } = useTranslation();
  const menu = useMenuContext("WorkspaceLabelCreatePage");
  const { targetHost: host } = useWorkspaceLabelProjection(serverId);
  const [name, setName] = useState("");
  const [color, setColor] = useState<WorkspaceLabelColor>(DEFAULT_CREATE_COLOR);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = host?.status !== "online";

  const submit = useCallback(() => {
    const trimmed = normalizeWorkspaceLabelName(name);
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    workspaceLabels
      .setAssignment({
        serverId,
        workspaceId,
        label: { name: trimmed, color },
        assigned: true,
      })
      .then(() => menu.goBack())
      .catch((cause: unknown) => setError(workspaceLabelErrorMessage(cause)))
      .finally(() => setPending(false));
  }, [color, menu, name, pending, serverId, workspaceId]);

  return (
    <>
      <MenuTextField
        onChangeText={setName}
        placeholder={t("workspaceLabels.name")}
        autoFocus
        editable={!offline && !pending}
        onSubmitEditing={submit}
        testID="workspace-label-picker-create-name"
      />
      <View style={styles.swatches}>
        <WorkspaceLabelSwatchRow
          value={color}
          onChange={setColor}
          disabled={offline || pending}
          testID="workspace-label-picker-create-colors"
        />
      </View>
      <MenuSeparator />
      <MenuItem
        disabled={offline || !normalizeWorkspaceLabelName(name)}
        status={pending ? "pending" : "idle"}
        pendingLabel={t("workspaceLabels.creating")}
        closeOnSelect={false}
        onSelect={submit}
        testID="workspace-label-picker-create-submit"
      >
        {t("workspaceLabels.createConfirm")}
      </MenuItem>
      {error ? <MenuHint testID="workspace-label-picker-error">{error}</MenuHint> : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The swatches start where a row's label starts, so the page reads down one rail: field text,
  // first swatch, commit row. The inset is the text's box, which leaves the round swatch hanging
  // a hair left of the letters beside it — that overshoot is what makes a circle look aligned
  // with a flat stem, so it is the rail rather than a miss. Vertical room of its own because the
  // page's row gap is zero.
  swatches: {
    paddingHorizontal: menuRowContentInset(theme),
    paddingVertical: theme.spacing[2],
  },
}));
