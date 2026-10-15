import { useRef, useCallback, useMemo } from "react";
import { Text, ScrollView, View, type ViewStyle } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import {
  Button,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import type { RpcOutput } from "@getpaseo/plugin";
import { statusRpc, handoffToProfileRpc } from "../shared/rpc";

const handoffStyle: ViewStyle = { padding: 16, gap: 8 };
const profilesStyle: ViewStyle = {
  flexDirection: "row",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

function ProfileButton({
  profile,
  busy,
  disabled,
  handoff,
}: {
  profile: { id: string; name: string };
  busy: boolean;
  disabled: boolean;
  handoff: (profileId: string) => void;
}) {
  const onPress = useCallback(() => handoff(profile.id), [handoff, profile.id]);
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled}
      loading={busy}
      onPress={onPress}
      accessibilityLabel={profile.name}
    >
      <Text>{profile.name}</Text>
    </Button>
  );
}

function Handoff({
  data,
  theme,
  navigation,
}: {
  data: RpcOutput<typeof statusRpc>;
  theme: PluginAgentPanelProps["theme"];
  navigation: PluginAgentPanelProps["navigation"];
}) {
  const pending = useRef(false);
  const execute = useRpc(handoffToProfileRpc);
  const mutation = useMutation({
    mutationFn: async (profileId: string) => {
      if (!data.plan) throw new Error("The handoff plan is no longer current.");
      return execute({ ...data.plan, profileId });
    },
    onSuccess: ({ agentId }) => {
      if (navigation?.replaceAgent) navigation.replaceAgent({ agentId });
      else navigation?.openAgent({ agentId });
    },
    onSettled: () => {
      pending.current = false;
    },
  });
  const handoff = useCallback(
    (profileId: string) => {
      if (pending.current) return;
      pending.current = true;
      mutation.mutate(profileId);
    },
    [mutation],
  );
  const openExecutor = useCallback(() => {
    if (data.handoff?.agentId) navigation?.openAgent({ agentId: data.handoff.agentId });
  }, [data.handoff?.agentId, navigation]);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const executorId = data.handoff?.agentId;
  if (!data.plan && !executorId) return null;
  return (
    <SettingsSection title="Handoff">
      <SettingsCard>
        {data.plan ? (
          <View style={handoffStyle}>
            <View testID="workflow-handoff-profiles" style={profilesStyle}>
              <Text style={textStyle}>Handoff :</Text>
              {data.profiles?.length ? (
                data.profiles.map((profile) => (
                  <ProfileButton
                    key={profile.id}
                    profile={profile}
                    handoff={handoff}
                    disabled={mutation.isPending}
                    busy={mutation.isPending && mutation.variables === profile.id}
                  />
                ))
              ) : (
                <Text style={textStyle}>Aucun profil disponible</Text>
              )}
            </View>
            {mutation.error ? (
              <Text accessibilityRole="alert" style={textStyle}>
                {mutation.error.message}
              </Text>
            ) : null}
          </View>
        ) : null}
        {executorId ? (
          <SettingsAction
            label="Executor created"
            actionLabel="Open executor"
            hint={executorId}
            disabled={!navigation}
            onPress={openExecutor}
          />
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
          <Handoff
            key={query.data.plan?.callId ?? "none"}
            data={query.data}
            theme={theme}
            navigation={navigation}
          />
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
