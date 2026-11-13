import type {
  AgentTimelineComposer,
  AgentTimelineControls,
  AgentTimelineProps,
} from "@getpaseo/plugin/client/ui";
import { lazy, Suspense, useRef } from "react";
import type { AgentEmbedComposer } from "@/agent-embed";
import { FilePanelLoading } from "@/file-panels/loading";
import type { ComposerControlsScope, ComposerItemsScope } from "@/composer/controls-scope";
import { usePluginInstallation } from "../installation-provider";

/**
 * The embed renders the agent tab's chain, composer included. Every plugin loads this module's
 * siblings with the plugin runtime, and the plugin runtime loads with the host runtime, so a static
 * import would put the whole chat surface in the host runtime's import graph. Only the first
 * timeline of a session waits for it.
 */
const AgentEmbed = lazy(async () => ({ default: (await import("@/agent-embed")).AgentEmbed }));

const LOADING = <FilePanelLoading />;

const NO_CONTROLS: ComposerControlsScope = {
  model: false,
  mode: false,
  thinking: false,
  options: false,
  attachments: false,
  voice: false,
  autocomplete: false,
  usage: false,
  items: { kind: "only", pluginId: "", itemIds: [] },
};

function resolveItems(items: AgentTimelineComposer["items"], pluginId: string): ComposerItemsScope {
  if (items === undefined || items === "all") return { kind: "all" };
  const itemIds = items === "none" ? [] : items;
  return { kind: "only", pluginId, itemIds };
}

function resolveControls(input: {
  controls: AgentTimelineComposer["controls"];
  items: ComposerItemsScope;
}): ComposerControlsScope {
  const { controls, items } = input;
  if (controls === "none") return NO_CONTROLS;
  const chosen: AgentTimelineControls =
    controls === undefined || controls === "all" ? {} : controls;
  return {
    model: chosen.model !== "hidden",
    mode: chosen.mode !== "hidden",
    thinking: chosen.thinking !== "hidden",
    options: chosen.options !== "hidden",
    attachments: chosen.attachments !== "hidden",
    voice: true,
    autocomplete: true,
    usage: true,
    items,
  };
}

function sameItems(left: ComposerItemsScope, right: ComposerItemsScope): boolean {
  if (left.kind === "all" || right.kind === "all") return left.kind === right.kind;
  return (
    left.pluginId === right.pluginId &&
    left.itemIds.length === right.itemIds.length &&
    left.itemIds.every((id, index) => id === right.itemIds[index])
  );
}

function sameComposer(left: AgentEmbedComposer | null, right: AgentEmbedComposer | null): boolean {
  if (left === null || right === null) return left === right;
  const a = left.controls;
  const b = right.controls;
  return (
    left.placeholder === right.placeholder &&
    a.model === b.model &&
    a.mode === b.mode &&
    a.thinking === b.thinking &&
    a.options === b.options &&
    a.attachments === b.attachments &&
    a.voice === b.voice &&
    a.autocomplete === b.autocomplete &&
    a.usage === b.usage &&
    sameItems(a.items, b.items)
  );
}

/**
 * Plugins pass fresh option literals on every render. Keeping the resolved options' identity
 * while they are equal spares the composer, which reads them from context, a render each time.
 */
function useStableComposer(next: AgentEmbedComposer | null): AgentEmbedComposer | null {
  const retained = useRef(next);
  if (!sameComposer(retained.current, next)) retained.current = next;
  return retained.current;
}

function resolveComposer(
  composer: AgentTimelineProps["composer"],
  pluginId: string,
): AgentEmbedComposer | null {
  if (composer === false) return null;
  const options = composer ?? {};
  return {
    controls: resolveControls({
      controls: options.controls,
      items: resolveItems(options.items, pluginId),
    }),
    placeholder: options.placeholder,
  };
}

export function AgentTimeline({ agentId, serverId, composer, testID }: AgentTimelineProps) {
  const plugin = usePluginInstallation();
  const embedComposer = useStableComposer(resolveComposer(composer, plugin.id));

  return (
    <Suspense fallback={LOADING}>
      <AgentEmbed
        serverId={serverId ?? plugin.serverId}
        agentId={agentId}
        composer={embedComposer}
        testID={testID}
      />
    </Suspense>
  );
}
