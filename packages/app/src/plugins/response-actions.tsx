import { useMemo } from "react";
import type {
  PluginResponseActionContext,
  PluginResponseActionContribution,
} from "@getpaseo/plugin/client";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useInstalledPlugins } from "./registry";
import { PluginRuntimeBoundary } from "./runtime-boundary";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { useSpeech } from "./speech";
import { ResponseActionMenu } from "./response-action-menu";

function ResponseMenu(props: {
  action: PluginResponseActionContribution;
  agentId: string;
  responseId: string;
  getContent(): string;
}) {
  const speech = useSpeech();
  const context = useMemo<PluginResponseActionContext>(
    () => ({
      agentId: props.agentId,
      responseId: props.responseId,
      getContent: props.getContent,
      speech,
    }),
    [props.agentId, props.responseId, props.getContent, speech],
  );
  return <ResponseActionMenu action={props.action} context={context} />;
}

export function PluginResponseActions(props: {
  serverId: string;
  agentId: string;
  responseId: string;
  getContent(): string;
}) {
  const installed = useInstalledPlugins();
  const client = useHostRuntimeClient(props.serverId);
  if (!client) return null;
  return (
    <>
      {installed
        .filter((plugin) => plugin.serverId === props.serverId)
        .flatMap((plugin) =>
          (plugin.responseActions ?? []).map((action) => (
            <SurfaceErrorBoundary
              key={`${plugin.id}/${action.id}`}
              installation={plugin}
              Surface={ResponseMenu}
              resetKey={props.responseId}
            >
              <PluginRuntimeBoundary plugin={plugin} client={client}>
                <ResponseMenu {...props} action={action} />
              </PluginRuntimeBoundary>
            </SurfaceErrorBoundary>
          )),
        )}
    </>
  );
}
