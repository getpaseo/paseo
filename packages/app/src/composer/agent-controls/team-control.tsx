import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { View } from "react-native";
import { Users } from "lucide-react-native";
import type { AgentTeamSummary } from "@getpaseo/protocol/messages";
import type { AgentTeamModelOption } from "@/agent-teams/use-agent-team-selection";
import { describeTeamRoles, formatTeamRoleModel } from "@/agent-teams/team-selection";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";

const NO_TEAM_ID = "";
const TEAM_DEFAULT_MODEL_ID = "";

export interface AgentTeamControlValue {
  teams: AgentTeamSummary[];
  selectedTeam: string | null;
  onSelectTeam: (team: string | null) => void;
  /** Role name -> model for the chat being created. */
  roleModelOverrides?: Record<string, string>;
  /** Role name -> the models its provider offers. A role without models has no model page. */
  roleModelOptions?: Record<string, AgentTeamModelOption[]>;
  onSetRoleModel?: (role: string, model: string | null) => void;
  disabled?: boolean;
}

/**
 * The new-chat team picker. Callers render it only when the host defines teams. With a team
 * selected, the list also offers one row per role that opens that role's model list.
 */
export function AgentTeamControl({
  teams,
  selectedTeam,
  onSelectTeam,
  roleModelOverrides,
  roleModelOptions,
  onSetRoleModel,
  disabled = false,
  surface = "toolbar",
  onClose,
}: AgentTeamControlValue & { surface?: "toolbar" | "sheet"; onClose?: () => void }) {
  const { t } = useTranslation();
  const { presentation } = useComposerControlLayout();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  /** The role whose model list is showing, or null for the team list. */
  const [rolePage, setRolePage] = useState<string | null>(null);

  const selectedRoles = useMemo(
    () => teams.find((team) => team.name === selectedTeam)?.roles ?? [],
    [selectedTeam, teams],
  );
  const pageRole = selectedRoles.find((role) => role.name === rolePage) ?? null;

  const { options, roleRowIds } = useMemo(() => {
    const teamOptions: ComboboxOption[] = [
      { id: NO_TEAM_ID, label: t("agentControls.team.none") },
      ...teams.map((team) => ({
        id: team.name,
        label: team.name,
        description: describeTeamRoles(team.roles),
      })),
    ];
    const taken = new Set(teamOptions.map((option) => option.id));
    const rowIds = new Map<string, string>();
    if (onSetRoleModel) {
      for (const role of selectedRoles) {
        if ((roleModelOptions?.[role.name] ?? []).length === 0) continue;
        let id = `role:${role.name}`;
        while (taken.has(id)) id = `${id}:`;
        taken.add(id);
        rowIds.set(id, role.name);
        const override = roleModelOverrides?.[role.name];
        teamOptions.push({
          id,
          label: t("agentControls.team.roleModel", { role: role.name }),
          description: override ? `${role.provider}/${override}` : formatTeamRoleModel(role),
        });
      }
    }
    return { options: teamOptions, roleRowIds: rowIds };
  }, [onSetRoleModel, roleModelOptions, roleModelOverrides, selectedRoles, t, teams]);

  const modelOptions = useMemo<ComboboxOption[]>(() => {
    if (!pageRole) return [];
    return [
      {
        id: TEAM_DEFAULT_MODEL_ID,
        label: t("agentControls.team.teamDefaultModel"),
        description: formatTeamRoleModel(pageRole),
      },
      ...(roleModelOptions?.[pageRole.name] ?? []).map((model) => ({
        id: model.id,
        label: model.label,
        description: model.id,
      })),
    ];
  }, [pageRole, roleModelOptions, t]);

  const valueLabel = selectedTeam ?? t("agentControls.team.none");

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        setRolePage(null);
        onClose?.();
      }
    },
    [onClose],
  );
  const handlePress = useCallback(() => {
    setRolePage(null);
    setOpen((current) => !current);
  }, []);
  const handleSelect = useCallback(
    (id: string) => {
      if (pageRole) {
        onSetRoleModel?.(pageRole.name, id === TEAM_DEFAULT_MODEL_ID ? null : id);
        setRolePage(null);
        return;
      }
      const role = roleRowIds.get(id);
      if (role !== undefined) {
        setRolePage(role);
        return;
      }
      onSelectTeam(id === NO_TEAM_ID ? null : id);
      handleOpenChange(false);
    },
    [handleOpenChange, onSelectTeam, onSetRoleModel, pageRole, roleRowIds],
  );

  return (
    <>
      <AgentControlTrigger
        ref={anchorRef}
        icon={Users}
        surface={surface}
        label={t("agentControls.team.title")}
        value={valueLabel}
        showToolbarLabel={selectedTeam !== null && presentation.showModeLabel}
        showCaret={surface === "toolbar" && presentation.showCarets}
        open={open}
        disabled={disabled}
        onPress={handlePress}
        accessibilityLabel={t("agentControls.team.selectWithValue", { value: valueLabel })}
        testID="team-control"
      />
      <Combobox
        options={pageRole ? modelOptions : options}
        value={
          pageRole
            ? (roleModelOverrides?.[pageRole.name] ?? TEAM_DEFAULT_MODEL_ID)
            : (selectedTeam ?? NO_TEAM_ID)
        }
        onSelect={handleSelect}
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={260}
        title={
          pageRole
            ? t("agentControls.team.roleModel", { role: pageRole.name })
            : t("agentControls.team.title")
        }
      />
    </>
  );
}
