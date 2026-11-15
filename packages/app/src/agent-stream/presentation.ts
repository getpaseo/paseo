import { isTurnBoundary } from "./turn-membership";
import { indexToolImages } from "@/tool-calls/detail-level/image-index";
import type { ChatDisplay } from "@/hooks/use-settings";
import type { TimelineItemTransform } from "@/plugins/timeline/model";
import { projectPluginTimelineItems } from "@/plugins/timeline/projection";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
  type PreparedToolCallHistory,
  type ToolCallDetailLevel,
  type ToolCallDetailProjection,
} from "@/tool-calls/detail-level/projection";
import type { StreamItem, UserMessageItem } from "@/types/stream";
import { collapseTurns, type TurnCollapse } from "./turn-collapse/model";
import type { ReadingRowReplacements } from "./reading-anchor";
import {
  collectToolCallImages,
  type ToolCallImage,
} from "@/tool-calls/detail-level/overview/model";

interface PresentationInput {
  tail: StreamItem[];
  head: StreamItem[];
  transform: TimelineItemTransform | undefined;
  display: ChatDisplay;
  autoExpandReasoning?: boolean;
  /** User messages whose collapsed turn the reader opened. */
  expandedTurnHostIds: ReadonlySet<string>;
  isTurnActive: boolean;
  activeTurnId?: string | null;
}

interface ToolCallImageLookup {
  get(itemId: string): readonly ToolCallImage[] | undefined;
}

export interface StreamPresentation extends ToolCallDetailProjection {
  turns: Omit<TurnCollapse, "tail">;
  readingRowReplacements: ReadingRowReplacements;
  toolImagesByItemId: ToolCallImageLookup;
  historyImageUpdates: ReadonlySet<string>;
}

function toolImageGroups(
  rows: readonly StreamItem[],
  groups: ToolCallDetailProjection["groupsByHostId"],
): ReadonlyMap<string, readonly ToolCallImage[]> {
  const imagesByItem = new Map<string, readonly ToolCallImage[]>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (group) {
      for (const image of group.images) imagesByItem.set(image.itemId, group.images);
    } else if (row.kind === "assistant_message") {
      const images = collectToolCallImages([row]);
      if (images.length > 0) imagesByItem.set(row.id, images);
    }
  }
  return imagesByItem;
}

const EMPTY_HOSTS: ReadonlyMap<string, string> = new Map();
const NO_IMAGE_UPDATES: ReadonlySet<string> = new Set();

function groupedRowHosts(
  rows: readonly StreamItem[],
  groups: ToolCallDetailProjection["groupsByHostId"],
): ReadonlyMap<string, string> {
  const hosts = new Map<string, string>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (!group) continue;
    for (const call of group.run.calls) {
      if (call.id !== row.id) hosts.set(call.id, row.id);
    }
  }
  return hosts;
}

const NO_COLLAPSED_TURNS: StreamPresentation["turns"] = collapseTurns({
  tail: [],
  isLatestTurnOpen: false,
  expandedHostIds: new Set(),
  getGroupedCalls: () => undefined,
  previousSummaryRowsByHostId: new Map(),
});

/** Source messages reach plugins before display projection. */
export function createStreamPresentation() {
  const userMessageCache = new WeakMap<UserMessageItem, UserMessageItem>();

  function presentUserMessage(item: UserMessageItem): UserMessageItem {
    const cached = userMessageCache.get(item);
    if (cached) return cached;

    // Recognize the complete voice envelope, including older messages without the
    // instruction suffix. Leave quoted examples and unrelated XML untouched.
    const spokenInput =
      /^\s*<spoken-input>([\s\S]*?)<\/spoken-input>(?:\s*<instruction>This message was spoken by the user\.[\s\S]*?<\/instruction>)?\s*$/.exec(
        item.text,
      );
    const projected = spokenInput ? { ...item, text: spokenInput[1].trim() } : item;
    userMessageCache.set(item, projected);
    return projected;
  }

  let historySource: StreamItem[] | undefined;
  let historyTransform: TimelineItemTransform | undefined;
  let historyRows: StreamItem[] = [];
  let preparedTail: StreamItem[] | undefined;
  let preparedAutoExpandReasoning: boolean | undefined;
  let preparedLevel: ToolCallDetailLevel | undefined;
  let preparedHistory: PreparedToolCallHistory | null = null;
  let fullImageRun: ReturnType<typeof indexToolImages>["pending"] | undefined;
  let historyGroupHosts: ReadonlyMap<string, string> = new Map();
  let historyToolImages: ReadonlyMap<string, readonly ToolCallImage[]> = new Map();
  let collapsedSource: StreamItem[] | undefined;
  let collapsedIsLatestTurnOpen = false;
  let collapsedExpandedHostIds: ReadonlySet<string> | undefined;
  let collapsed: TurnCollapse | undefined;

  function presentRows(item: StreamItem): StreamItem[] {
    if (item.kind === "tool_call" && item.payload.source === "agent") {
      const message = item.payload.data.agentMessage;
      if (message?.event === "message") {
        return [
          {
            kind: "user_message",
            id: item.id,
            turnId: item.turnId,
            timelineCursor: item.timelineCursor,
            timestamp: item.timestamp,
            text: message.text,
            sender: message.sender,
          },
        ];
      }
    }
    return [item.kind === "user_message" ? presentUserMessage(item) : item];
  }

  function collapse(
    projection: ToolCallDetailProjection,
    input: PresentationInput,
  ): Omit<
    StreamPresentation,
    "readingRowReplacements" | "toolImagesByItemId" | "historyImageUpdates"
  > {
    if (input.display !== "collapseTurns") {
      return { ...projection, turns: NO_COLLAPSED_TURNS };
    }
    // Live text updates reach the head only, so the folded history is reused until the
    // retained rows, the latest turn's liveness, or the reader's expanded turns change.
    const last = projection.tail.at(-1) ?? null;
    const first = projection.head[0] ?? null;
    const activeTurnIsAnother = Boolean(
      input.activeTurnId && last?.turnId && input.activeTurnId !== last.turnId,
    );
    // Without head rows, the latest retained turn is live only while the active run is that
    // turn. A run that has not opened yet carries no id and belongs to the next turn.
    const isLatestTurnOpen = first
      ? !isTurnBoundary(last, first) && !activeTurnIsAnother
      : input.isTurnActive && (last?.turnId === undefined || input.activeTurnId === last.turnId);
    if (
      !collapsed ||
      collapsedSource !== projection.tail ||
      collapsedIsLatestTurnOpen !== isLatestTurnOpen ||
      collapsedExpandedHostIds !== input.expandedTurnHostIds
    ) {
      collapsed = collapseTurns({
        tail: projection.tail,
        isLatestTurnOpen,
        expandedHostIds: input.expandedTurnHostIds,
        getGroupedCalls: (itemId) => projection.groupsByHostId.get(itemId)?.run.calls,
        previousSummaryRowsByHostId:
          collapsed?.summaryRowsByHostId ?? NO_COLLAPSED_TURNS.summaryRowsByHostId,
      });
      collapsedSource = projection.tail;
      collapsedIsLatestTurnOpen = isLatestTurnOpen;
      collapsedExpandedHostIds = input.expandedTurnHostIds;
    }
    const { tail, ...turns } = collapsed;
    if (turns.nestedItemIds.size === 0) return { ...projection, tail, turns };
    // Opening a turn reveals its raw calls; those rows must not become group hosts again.
    const withoutExpandedRows = (groups: StreamPresentation["groupsByHostId"]) => ({
      size: groups.size - [...turns.nestedItemIds].filter((id) => groups.has(id)).length,
      get: (id: string) => (turns.nestedItemIds.has(id) ? undefined : groups.get(id)),
      has: (id: string) => !turns.nestedItemIds.has(id) && groups.has(id),
    });
    return {
      ...projection,
      tail,
      turns,
      groupsByHostId: withoutExpandedRows(projection.groupsByHostId),
      historyGroupUpdatesByHostId: withoutExpandedRows(projection.historyGroupUpdatesByHostId),
    };
  }

  return (input: PresentationInput): StreamPresentation => {
    const level: ToolCallDetailLevel = input.display === "full" ? "detailed" : "overview";
    // Retained history is not reprojected or regrouped on each live text update.
    if (historySource !== input.tail || historyTransform !== input.transform) {
      historyRows = projectPluginTimelineItems(input.tail, input.transform).flatMap<StreamItem>(
        (item) => presentRows(item),
      );
      historySource = input.tail;
      historyTransform = input.transform;
    }
    const head: StreamItem[] = [];
    for (const item of projectPluginTimelineItems(input.head, input.transform, "streaming")) {
      const blocks = presentRows(item);
      head.push(...blocks);
    }
    const historyChanged =
      preparedTail !== historyRows ||
      preparedLevel !== level ||
      preparedAutoExpandReasoning !== input.autoExpandReasoning;
    if (historyChanged) {
      preparedHistory = prepareToolCallHistory(level, historyRows, input.autoExpandReasoning);
      historyGroupHosts = preparedHistory
        ? groupedRowHosts(preparedHistory.grouped.tail, preparedHistory.grouped.groupsByHostId)
        : EMPTY_HOSTS;
    }
    const projection = projectToolCallDetailLevel({
      level,
      tail: historyRows,
      head,
      preparedHistory,
      isTurnActive: input.isTurnActive,
    });
    if (historyChanged) {
      if (preparedHistory) {
        historyToolImages = toolImageGroups(
          preparedHistory.grouped.tail,
          preparedHistory.grouped.groupsByHostId,
        );
        fullImageRun = undefined;
      } else {
        const indexed = indexToolImages(projection.tail, input.autoExpandReasoning);
        historyToolImages = indexed.byItemId;
        fullImageRun = indexed.pending;
      }
      preparedTail = historyRows;
      preparedLevel = level;
      preparedAutoExpandReasoning = input.autoExpandReasoning;
    }
    const result = collapse(projection, input);
    const imageHost = projection.tail.at(-1);
    const liveToolImages = preparedHistory
      ? toolImageGroups(
          imageHost ? [imageHost, ...projection.head] : projection.head,
          projection.groupsByHostId,
        )
      : indexToolImages(projection.head, input.autoExpandReasoning, fullImageRun).byItemId;
    const retainedToolImages = historyToolImages;
    const changedImageGroup = imageHost && projection.historyGroupUpdatesByHostId.get(imageHost.id);
    const changedImages = preparedHistory
      ? changedImageGroup?.images.map((image) => image.itemId)
      : [...liveToolImages.keys()];
    const historyImageUpdates = changedImages?.length ? new Set(changedImages) : NO_IMAGE_UPDATES;
    // Only the trailing retained group can absorb head rows. Reuse the retained
    // index across streaming updates rather than walking the full history again.
    const last = projection.tail.at(-1);
    const liveGroupHosts = groupedRowHosts(
      last ? [last, ...projection.head] : projection.head,
      projection.groupsByHostId,
    );
    const retainedGroupHosts = historyGroupHosts;
    return {
      ...result,
      historyImageUpdates,
      toolImagesByItemId: {
        get: (id) => liveToolImages.get(id) ?? retainedToolImages.get(id),
      },
      readingRowReplacements: {
        get(id) {
          if (result.turns.nestedItemIds.has(id)) return undefined;
          const groupHost = liveGroupHosts.get(id) ?? retainedGroupHosts.get(id) ?? id;
          return (
            result.turns.hostIdByHiddenRowId.get(id) ??
            result.turns.hostIdByHiddenRowId.get(groupHost) ??
            (groupHost === id ? undefined : groupHost)
          );
        },
      },
    };
  };
}
