import { useMemo, type ReactElement } from "react";
import { useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import type { PickerItem, RefAction } from "../../new-workspace-picker-item";

/** Which list the ref picker shows: branches or pull requests. */
export type RefList = PickerItem["kind"];

/** Below this width "Pull requests" and the action control do not fit on one row. */
const SHORT_LABEL_MAX_WIDTH = 390;

/**
 * The ref picker's row under its search field: the list on the left, and on the right what a
 * new worktree does with the pick. Each action segment says what it does while the pointer is on it.
 * The action control is left out on a host that only knows the default actions.
 */
export function RefPickerToolbar({
  list,
  onListChange,
  action,
  onActionChange,
  canChooseAction,
  changeRequestContext: context,
}: {
  list: RefList;
  onListChange: (list: RefList) => void;
  action: RefAction;
  onActionChange: (action: RefAction) => void;
  canChooseAction: boolean;
  changeRequestContext: "mr" | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const isNarrow = useWindowDimensions().width < SHORT_LABEL_MAX_WIDTH;
  const listOptions = useMemo<SegmentedControlOption<RefList>[]>(
    () => [
      {
        value: "branch",
        label: t("newWorkspace.refPicker.branches"),
        testID: "new-workspace-ref-picker-tab-branches",
      },
      {
        value: "github-pr",
        label: isNarrow
          ? t("newWorkspace.refPicker.pullRequestsShort", { context })
          : t("newWorkspace.refPicker.pullRequests", { context }),
        testID: "new-workspace-ref-picker-tab-pull-requests",
      },
    ],
    [context, isNarrow, t],
  );
  const actionOptions = useMemo<SegmentedControlOption<RefAction>[]>(
    () => [
      {
        value: "branch-off",
        label: t("newWorkspace.refPicker.branchOff"),
        tooltip: t("newWorkspace.refPicker.branchOffHint"),
        testID: "new-workspace-ref-picker-branch-off",
      },
      {
        value: "checkout",
        label: t("newWorkspace.refPicker.checkout"),
        tooltip: t("newWorkspace.refPicker.checkoutHint"),
        testID: "new-workspace-ref-picker-checkout",
      },
    ],
    [t],
  );
  return (
    <>
      <SegmentedControl
        size="sm"
        options={listOptions}
        value={list}
        onValueChange={onListChange}
        testID="new-workspace-ref-picker-tabs"
      />
      {canChooseAction ? (
        <SegmentedControl
          size="sm"
          options={actionOptions}
          value={action}
          onValueChange={onActionChange}
          testID="new-workspace-ref-picker-action"
        />
      ) : null}
    </>
  );
}
