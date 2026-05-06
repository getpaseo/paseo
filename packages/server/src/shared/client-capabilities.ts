export const CLIENT_CAPS = {
  reasoningMergeEnum: "reasoning_merge_enum",
} as const;

export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];
