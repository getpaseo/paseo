import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Check, ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ProjectIconView } from "@/components/project-icon-view";
import { useProjectIcons } from "@/projects/icons";
import { resolveSidebarProjectIconTargets } from "@/utils/sidebar-project-row-model";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";
import {
  openProjectGroupCreateForm,
  partitionProjectGroupCreateMembers,
  type ProjectGroupCreateFormMember,
} from "./create-form-model";
import {
  useProjectGroupCreateModalStore,
  type ProjectGroupCreateRequest,
} from "./create-modal-store";
import { projectGroupOutcomeMessage } from "./picker";
import { setProjectGroupOnProjects, useKnownProjectGroups } from "./index";

const MEMBER_ICON_SIZE = 16;
const CHECK_ICON_SIZE = 14;
const ThemedCheck = withUnistyles(Check);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Naming a new group and picking which known projects join it, as one sheet.
 *
 * Mounted once, near `SidebarWorkspaceList`, and driven entirely by the store: every opener
 * (the project menu's "New group…", the display-preferences menu, a web drag onto "New group")
 * calls `openProjectGroupCreateModal`, not a prop on this component. `key={request.id}` remounts
 * the sheet fresh on every open, so a form left half-typed from a cancelled attempt never leaks
 * into the next one.
 */
export function ProjectGroupCreateModal({
  projects,
}: {
  projects: readonly SidebarProjectEntry[];
}): ReactElement | null {
  const request = useProjectGroupCreateModalStore((state) => state.request);
  const close = useProjectGroupCreateModalStore((state) => state.close);
  const requestId = request?.id ?? null;
  const handleClose = useCallback(() => {
    if (requestId !== null) close(requestId);
  }, [close, requestId]);

  if (!request) return null;
  return (
    <ProjectGroupCreateSheet
      key={request.id}
      request={request}
      projects={projects}
      onClose={handleClose}
    />
  );
}

function ProjectGroupCreateSheet({
  request,
  projects,
  onClose,
}: {
  request: ProjectGroupCreateRequest;
  projects: readonly SidebarProjectEntry[];
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const knownGroups = useKnownProjectGroups();

  const projectsByViewKey = useMemo(
    () => new Map(projects.map((project) => [project.viewKey, project])),
    [projects],
  );

  // The rows and the model share one member list fixed at open (docs/forms.md: options are
  // owned state, never re-derived from a live list), so a project that appears or disappears
  // while the sheet is open changes nothing until the next open.
  const [members] = useState(() =>
    projects.map((project) => ({
      viewKey: project.viewKey,
      name: project.projectName,
      group: project.group,
    })),
  );
  const [sections] = useState(() => partitionProjectGroupCreateMembers(members));
  const [model] = useState(() =>
    openProjectGroupCreateForm({
      members,
      knownGroups,
      preselectedViewKeys: request.preselectedViewKeys,
      submit: ({ viewKeys, group }) => {
        const selectedProjects = viewKeys.flatMap((viewKey) => {
          const project = projectsByViewKey.get(viewKey);
          return project ? [project] : [];
        });
        return setProjectGroupOnProjects({ projects: selectedProjects, group });
      },
      describeOutcome: (outcome) => projectGroupOutcomeMessage(t, outcome),
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  // A project can be in one group at a time, so ticking a grouped project moves it. Those rows
  // sit apart and closed by default so the list opens on the projects that cost nothing to add.
  // The section opens itself when it holds the project this sheet was opened for, or when every
  // project is grouped and closing it would leave nothing to pick.
  const [groupedOpen, setGroupedOpen] = useState(
    () =>
      sections.ungrouped.length === 0 ||
      sections.grouped.some((member) => state.selected.has(member.viewKey)),
  );
  const toggleGrouped = useCallback(() => setGroupedOpen((open) => !open), []);

  const setName = useCallback((value: string) => model.setName(value), [model]);
  const toggleMember = useCallback((viewKey: string) => model.toggleMember(viewKey), [model]);
  const submit = useCallback(() => {
    void (async () => {
      if (await model.submit()) onClose();
    })();
  }, [model, onClose]);
  // Closing mid-write abandons the sheet, not the write: a compact sheet can be swiped away at
  // any time, so refusing here would only leave the store open on a sheet that is gone. The
  // write still lands or fails on the hosts; `onClose` is bound to this request, so a late
  // resolution cannot close a sheet opened after it.
  const handleClose = onClose;

  const iconTargets = useMemo(() => resolveSidebarProjectIconTargets(projects), [projects]);
  const iconByProjectViewKey = useProjectIcons({ projects: iconTargets });

  const header = useMemo<SheetHeader>(
    () => ({ title: t("sidebar.project.group.dropNewGroup") }),
    [t],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          variant="secondary"
          size="sm"
          style={styles.footerButton}
          onPress={handleClose}
          testID="project-group-create-cancel"
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          size="sm"
          style={styles.footerButton}
          disabled={!state.canSubmit}
          loading={state.pending}
          onPress={submit}
          testID="project-group-create-confirm"
        >
          {state.existingGroup
            ? t("sidebar.project.group.addToGroupConfirm")
            : t("sidebar.project.group.createConfirm")}
        </Button>
      </View>
    ),
    [handleClose, state.canSubmit, state.existingGroup, state.pending, submit, t],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={handleClose}
      header={header}
      footer={footer}
      testID="project-group-create-modal"
    >
      <Field label={t("sidebar.project.group.name")}>
        <FormTextInput
          size={isCompact ? "md" : "sm"}
          onChangeText={setName}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          editable={!state.pending}
          onSubmitEditing={submit}
          testID="project-group-create-input"
        />
      </Field>
      <Field label={t("sidebar.project.group.members")}>
        <View style={styles.memberList}>
          {sections.ungrouped.map((member) => (
            <ProjectGroupMemberRow
              key={member.viewKey}
              member={member}
              iconDataUri={iconByProjectViewKey.get(member.viewKey) ?? null}
              checked={state.selected.has(member.viewKey)}
              disabled={state.pending}
              onToggle={toggleMember}
            />
          ))}
          {sections.grouped.length > 0 ? (
            <View style={styles.memberList} testID="project-group-create-grouped-section">
              <ProjectGroupedSectionToggle
                count={sections.grouped.length}
                open={groupedOpen}
                onToggle={toggleGrouped}
              />
              {groupedOpen
                ? sections.grouped.map((member) => (
                    <ProjectGroupMemberRow
                      key={member.viewKey}
                      member={member}
                      iconDataUri={iconByProjectViewKey.get(member.viewKey) ?? null}
                      checked={state.selected.has(member.viewKey)}
                      disabled={state.pending}
                      onToggle={toggleMember}
                    />
                  ))
                : null}
            </View>
          ) : null}
        </View>
      </Field>
      {state.error ? (
        <Text style={styles.error} testID="project-group-create-error">
          {state.error}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

/**
 * The header that opens and closes the grouped projects. Same geometry as a member row so the
 * chevron sits on the icon rail; muted and `medium` because it names a group of rows rather
 * than being one (docs/design.md §3).
 */
function ProjectGroupedSectionToggle({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  // React Native Web does not map `accessibilityState.expanded` to `aria-expanded` either.
  const ariaExpandedProps = isWeb ? { "aria-expanded": open } : null;
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.memberRow,
      isHovered && styles.memberRowHovered,
      pressed && styles.memberRowPressed,
    ],
    [isHovered],
  );
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("sidebar.project.group.groupedMembers")}
        accessibilityState={accessibilityState}
        {...ariaExpandedProps}
        onPress={onToggle}
        style={rowStyle}
        testID="project-group-create-grouped-toggle"
      >
        <View style={styles.sectionChevron}>
          <Chevron size={CHECK_ICON_SIZE} uniProps={foregroundMutedMapping} />
        </View>
        <Text style={styles.sectionLabel} numberOfLines={1}>
          {t("sidebar.project.group.groupedMembers")}
        </Text>
        <Text style={styles.sectionCount}>{count}</Text>
      </Pressable>
    </View>
  );
}

function ProjectGroupMemberRow({
  member,
  iconDataUri,
  checked,
  disabled,
  onToggle,
}: {
  member: ProjectGroupCreateFormMember;
  iconDataUri: string | null;
  checked: boolean;
  disabled: boolean;
  onToggle: (viewKey: string) => void;
}): ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => onToggle(member.viewKey), [member.viewKey, onToggle]);
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  // React Native Web does not map `accessibilityState.checked` to `aria-checked`, so the web
  // attribute is set by hand, the same workaround the group header uses for `aria-expanded`.
  const ariaCheckedProps = isWeb ? { "aria-checked": checked } : null;
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.memberRow,
      isHovered && styles.memberRowHovered,
      pressed && styles.memberRowPressed,
    ],
    [isHovered],
  );

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={member.name}
        accessibilityState={accessibilityState}
        {...ariaCheckedProps}
        disabled={disabled}
        onPress={handlePress}
        style={rowStyle}
        testID={`project-group-create-member-${member.viewKey}`}
      >
        <ProjectIconView
          iconDataUri={iconDataUri}
          initial={projectIconPlaceholderLabelFromDisplayName(member.name).charAt(0).toUpperCase()}
          projectViewKey={member.viewKey}
          size={MEMBER_ICON_SIZE}
          textStyle={styles.memberIconText}
        />
        <Text style={styles.memberRowName} numberOfLines={1}>
          {member.name}
        </Text>
        {member.group !== null ? (
          <Text
            style={styles.memberRowGroup}
            numberOfLines={1}
            testID={`project-group-create-member-group-${member.viewKey}`}
          >
            {member.group}
          </Text>
        ) : null}
        {checked ? <ThemedCheck size={CHECK_ICON_SIZE} uniProps={foregroundMapping} /> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  memberList: {
    gap: theme.spacing[1],
  },
  // The fill bleeds past the row's logical column (negative margin cancels the padding) so the
  // hover/pressed highlight reaches wider than the text, while the icon still starts on the same
  // rail as the "Projects" label above it — docs/design.md's alignment rule.
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  memberRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  memberRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  memberRowName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  // The group the row would leave, as context: muted, and it yields to the name when space runs out.
  memberRowGroup: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // The chevron takes the icon's column so the section label lines up with the member names.
  sectionChevron: {
    width: MEMBER_ICON_SIZE,
    alignItems: "center",
  },
  sectionLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  sectionCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // 16pt icon, same ratio project-leading-visual.tsx uses at the same size.
  memberIconText: {
    fontSize: 9,
  },
  // docs/design.md: "Inline errors are a single sentence in `palette.red[300]` `xs`" — this
  // theme's smallest text token is `sm` (providers-section.tsx's `errorText` is the precedent).
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footerButton: {
    flex: 1,
  },
}));
