import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { isPaseoToolName } from "@getpaseo/protocol/tool-name-normalization";
import { getFileNameFromPath } from "@/attachments/utils";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";
import { resolveToolCallIconName, type ToolCallIcon } from "@/utils/tool-call-icon-name";

export const MIN_COMPACT_TOOL_CALLS = 4;

const DIRECT_PASEO_TOOL_PREFIX = "paseo_";
const DIRECT_SEARCH_TOOL_SUFFIX_PATTERN = /(?:^|[_.:/])(?:web_search|llm_context)$/;

export interface ToolCallCategorySummary {
  key: string;
  label: string;
  iconName: ToolCallIcon;
  callCount: number;
  failedCount: number;
  runningCount: number;
  resources: string[];
}

export interface CompactToolCallGroup {
  id: string;
  calls: ToolCallItem[];
  callCount: number;
  failedCount: number;
  isRunning: boolean;
  editedFileCount: number;
  commandCount: number;
  readFileCount: number;
  searchCount: number;
  otherToolCount: number;
  paseoCallCount: number;
  categories: ToolCallCategorySummary[];
}

export interface CompactToolCallRunsResult {
  tail: StreamItem[];
  head: StreamItem[];
  groupsByHostId: Map<string, CompactToolCallGroup>;
}

interface CompactToolCallRunsInput {
  tail: StreamItem[];
  head: StreamItem[];
  enabled: boolean;
}

interface TaggedStreamItem {
  segment: "tail" | "head";
  item: StreamItem;
}

interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
  error: unknown;
  metadata?: Record<string, unknown>;
}

interface ResourceSummary {
  key: string;
  label: string;
}

function describeToolCall(item: ToolCallItem): ToolCallDescriptor {
  if (item.payload.source === "agent") {
    const { data } = item.payload;
    return {
      detail: data.detail,
      name: data.name,
      status: data.status,
      error: data.error,
      metadata: data.metadata,
    };
  }

  const { data } = item.payload;
  return {
    detail: {
      type: "unknown",
      input: data.arguments ?? null,
      output: data.result ?? null,
    },
    name: data.toolName,
    status: data.status === "executing" ? "running" : data.status,
    error: data.error,
  };
}

function isCompactableToolCall(item: StreamItem): item is ToolCallItem {
  if (item.kind !== "tool_call") {
    return false;
  }
  const descriptor = describeToolCall(item);
  return descriptor.detail.type !== "plan" && descriptor.name.trim().toLowerCase() !== "speak";
}

function isDirectPaseoToolName(name: string): boolean {
  return name.startsWith(DIRECT_PASEO_TOOL_PREFIX);
}

function isDirectSearchToolName(name: string): boolean {
  return DIRECT_SEARCH_TOOL_SUFFIX_PATTERN.test(name);
}

function resourceForDetail(detail: ToolCallDetail): ResourceSummary | null {
  if (detail.type === "read" || detail.type === "edit" || detail.type === "write") {
    return {
      key: detail.filePath,
      label: getFileNameFromPath(detail.filePath) ?? detail.filePath,
    };
  }
  if (detail.type !== "fetch") {
    return null;
  }
  try {
    const hostname = new URL(detail.url).hostname || detail.url;
    return { key: hostname, label: hostname };
  } catch {
    return { key: detail.url, label: detail.url };
  }
}

function categoryIdentity(input: {
  descriptor: ToolCallDescriptor;
  normalizedName: string;
  displayName: string;
}): { key: string; label: string; iconName: ToolCallIcon } {
  if (isPaseoToolName(input.descriptor.name) || isDirectPaseoToolName(input.normalizedName)) {
    return { key: "paseo", label: "Paseo", iconName: "paseo" };
  }
  if (
    (input.descriptor.detail.type === "search" &&
      input.descriptor.detail.toolName === "web_search") ||
    isDirectSearchToolName(input.normalizedName)
  ) {
    return { key: "web_search", label: "Web search", iconName: "search" };
  }
  if (input.descriptor.detail.type === "fetch") {
    return { key: "fetch", label: "Web fetch", iconName: "search" };
  }
  if (input.descriptor.detail.type !== "unknown" && input.descriptor.detail.type !== "plain_text") {
    return {
      key: input.descriptor.detail.type,
      label: input.displayName,
      iconName: resolveToolCallIconName(input.descriptor.name, input.descriptor.detail),
    };
  }
  return {
    key: `tool:${input.displayName.toLowerCase()}`,
    label: input.displayName,
    iconName: resolveToolCallIconName(input.descriptor.name, input.descriptor.detail),
  };
}

function buildCompactToolCallGroup(calls: ToolCallItem[]) {
  const editedFiles = new Set<string>();
  const readFiles = new Set<string>();
  const categories = new Map<string, ToolCallCategorySummary>();
  const categoryResourceKeys = new Map<string, Set<string>>();
  let failedCount = 0;
  let isRunning = false;
  let commandCount = 0;
  let searchCount = 0;
  let otherToolCount = 0;
  let paseoCallCount = 0;

  for (const call of calls) {
    const descriptor = describeToolCall(call);
    const isFailed = descriptor.status === "failed";
    const isCallRunning = descriptor.status === "running";
    failedCount += isFailed ? 1 : 0;
    isRunning ||= isCallRunning;
    const normalizedName = descriptor.name.trim().toLowerCase();
    const display = buildToolCallDisplayModel({
      name: descriptor.name,
      status: descriptor.status,
      error: descriptor.error,
      detail: descriptor.detail,
      metadata: descriptor.metadata,
    });
    const identity = categoryIdentity({
      descriptor,
      normalizedName,
      displayName: display.displayName,
    });
    let category = categories.get(identity.key);
    if (!category) {
      category = {
        ...identity,
        callCount: 0,
        failedCount: 0,
        runningCount: 0,
        resources: [],
      };
      categories.set(identity.key, category);
    }
    category.callCount += 1;
    category.failedCount += isFailed ? 1 : 0;
    category.runningCount += isCallRunning ? 1 : 0;
    const resource = resourceForDetail(descriptor.detail);
    if (resource) {
      let resourceKeys = categoryResourceKeys.get(identity.key);
      if (!resourceKeys) {
        resourceKeys = new Set();
        categoryResourceKeys.set(identity.key, resourceKeys);
      }
      if (!resourceKeys.has(resource.key)) {
        resourceKeys.add(resource.key);
        category.resources.push(resource.label);
      }
    }

    if (isPaseoToolName(descriptor.name) || isDirectPaseoToolName(normalizedName)) {
      paseoCallCount += 1;
      continue;
    }
    if (descriptor.detail.type === "edit" || descriptor.detail.type === "write") {
      editedFiles.add(descriptor.detail.filePath);
      continue;
    }
    if (descriptor.detail.type === "shell") {
      commandCount += 1;
      continue;
    }
    if (descriptor.detail.type === "read") {
      readFiles.add(descriptor.detail.filePath);
      continue;
    }
    if (descriptor.detail.type === "search" || isDirectSearchToolName(normalizedName)) {
      searchCount += 1;
      continue;
    }
    otherToolCount += 1;
  }

  const firstCall = calls[0];
  if (!firstCall) {
    throw new Error("Cannot build an empty tool call group");
  }
  return {
    id: firstCall.id,
    calls,
    callCount: calls.length,
    failedCount,
    isRunning,
    editedFileCount: editedFiles.size,
    commandCount,
    readFileCount: readFiles.size,
    searchCount,
    otherToolCount,
    paseoCallCount,
    categories: [...categories.values()],
  } satisfies CompactToolCallGroup;
}

export function compactToolCallRuns(input: CompactToolCallRunsInput): CompactToolCallRunsResult {
  if (!input.enabled) {
    return {
      tail: input.tail,
      head: input.head,
      groupsByHostId: new Map(),
    };
  }

  const taggedItems: TaggedStreamItem[] = [
    ...input.tail.map((item) => ({ segment: "tail" as const, item })),
    ...input.head.map((item) => ({ segment: "head" as const, item })),
  ];
  const compactedTail: StreamItem[] = [];
  const compactedHead: StreamItem[] = [];
  const groupsByHostId = new Map<string, CompactToolCallGroup>();
  let pendingRun: TaggedStreamItem[] = [];

  const append = ({ segment, item }: TaggedStreamItem) => {
    (segment === "tail" ? compactedTail : compactedHead).push(item);
  };
  const flushRun = () => {
    if (pendingRun.length >= MIN_COMPACT_TOOL_CALLS) {
      const first = pendingRun[0];
      const latest = pendingRun.at(-1);
      if (!first || !latest) {
        throw new Error("Cannot compact an empty tool call run");
      }
      const calls = pendingRun.map(({ item }) => item as ToolCallItem);
      const stableHost: TaggedStreamItem = {
        segment: latest.segment,
        item: { ...latest.item, id: first.item.id },
      };
      append(stableHost);
      groupsByHostId.set(stableHost.item.id, buildCompactToolCallGroup(calls));
    } else {
      for (const entry of pendingRun) {
        append(entry);
      }
    }
    pendingRun = [];
  };

  for (const entry of taggedItems) {
    if (isCompactableToolCall(entry.item)) {
      pendingRun.push(entry);
      continue;
    }
    flushRun();
    append(entry);
  }
  flushRun();

  if (groupsByHostId.size === 0) {
    return {
      tail: input.tail,
      head: input.head,
      groupsByHostId,
    };
  }
  return {
    tail: compactedTail,
    head: compactedHead,
    groupsByHostId,
  };
}
