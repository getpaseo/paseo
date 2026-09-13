import { useState, useCallback, useMemo } from "react";
import { Text, ScrollView } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import type { RpcOutput } from "@getpaseo/plugin";
import { statusRpc, handoffRpc, executorSelection } from "../shared/rpc";

const executorOptions = [
  { label: "Choose executor", value: "" },
  { label: "Standard", value: "standard" },
  { label: "Advanced", value: "advanced" },
];

function Handoff({
  data,
  theme,
}: {
  data: RpcOutput<typeof statusRpc>;
  theme: PluginAgentPanelProps["theme"];
}) {
  const [selection, setSelection] = useState<string>(
    data.handoff?.selection ?? data.recommendation ?? "",
  );
  const effectiveSelection = data.handoff?.selection ?? selection;
  const completed = data.handoff?.phase === "running";
  const execute = useRpc(handoffRpc);
  const mutation = useMutation({
    mutationFn: () => {
      if (!data.plan) throw new Error("Open Hand off on the current pending plan.");
      return execute({ ...data.plan, selection: executorSelection.parse(effectiveSelection) });
    },
  });
  const handoff = useCallback(() => mutation.mutate(), [mutation]);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const executorId = data.handoff?.agentId ?? mutation.data?.agentId;
  if (!data.plan) return null;
  return (
    <SettingsSection title="Hand off">
      <SettingsCard>
        <SettingsSelect
          label="Executor"
          value={effectiveSelection}
          options={executorOptions}
          onValueChange={setSelection}
          disabled={Boolean(data.handoff) || mutation.isPending || mutation.isSuccess}
          hint={
            data.recommendation
              ? `Router recommendation: ${data.recommendation}`
              : "Select an executor profile before continuing"
          }
        />
        <SettingsAction
          label="Continue in a new root agent"
          actionLabel={mutation.isPending ? "Handing off..." : "Hand off"}
          hint="Closes this plan without executing in the planner. The new agent stays in this workspace."
          error={mutation.error?.message}
          disabled={!effectiveSelection || completed || mutation.isPending || mutation.isSuccess}
          onPress={handoff}
        />
        {executorId ? (
          <SettingsRow label="Executor created">
            <Text selectable style={textStyle}>
              {executorId}
            </Text>
          </SettingsRow>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function FinalReviewRow({
  review,
  navigation,
}: {
  review: RpcOutput<typeof statusRpc>["reviews"][number];
  navigation: PluginAgentPanelProps["navigation"];
}) {
  const openManager = useCallback(
    () => navigation?.openAgent({ agentId: review.managerId }),
    [navigation, review.managerId],
  );
  return (
    <SettingsAction
      label={
        review.phase === "verification_required"
          ? "Verification required"
          : review.phase.replaceAll("_", " ")
      }
      hint={review.reason ?? `Plan ${review.planId}`}
      actionLabel="Open manager"
      disabled={!navigation}
      onPress={openManager}
    />
  );
}

export function WorkflowPanel({
  workspaceId,
  agentId,
  theme,
  layout,
  navigation,
}: PluginAgentPanelProps) {
  const load = useRpc(statusRpc);
  const query = useQuery({
    queryKey: ["workflow-status", workspaceId, agentId],
    queryFn: () => load({ workspaceId, agentId }),
    refetchInterval: 5000,
  });
  const contentStyle = useMemo(() => ({ padding: layout.compact ? 16 : 24 }), [layout.compact]);
  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);
  return (
    <ScrollView contentContainerStyle={contentStyle}>
      {query.data ? (
        <>
          <Handoff key={query.data.plan?.callId ?? "none"} data={query.data} theme={theme} />
          <SettingsSection title="Final review">
            <SettingsCard>
              {query.data.verification?.map((item) => (
                <SettingsRow key={item.planId} label="Verification required" hint={item.reason} />
              ))}
              {query.data.reviews.length === 0 && !query.data.verification?.length ? (
                <SettingsRow label="No final review yet" />
              ) : (
                query.data.reviews.map((review) => (
                  <FinalReviewRow key={review.planId} review={review} navigation={navigation} />
                ))
              )}
            </SettingsCard>
          </SettingsSection>
        </>
      ) : (
        <SettingsSection title="Workflow">
          <SettingsCard>
            <SettingsAction
              label={query.isError ? "Unable to load workflow" : "Loading workflow..."}
              error={query.error?.message}
              actionLabel="Retry"
              disabled={query.isFetching}
              onPress={retry}
            />
          </SettingsCard>
        </SettingsSection>
      )}
    </ScrollView>
  );
}
