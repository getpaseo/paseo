import type { PluginTimelineItemSource } from "@getpaseo/plugin";

export function createPluginTimelineItemSource(
  input: PluginTimelineItemSource,
): PluginTimelineItemSource {
  const sourceSeqRanges = input.sourceSeqRanges.map((range) =>
    Object.freeze({ startSeq: range.startSeq, endSeq: range.endSeq }),
  );
  return Object.freeze({
    epoch: input.epoch,
    seqStart: input.seqStart,
    seqEnd: input.seqEnd,
    sourceSeqRanges: Object.freeze(sourceSeqRanges),
  });
}
