import type { DictationWrapSettings } from "@getpaseo/protocol/speech/rpc-schemas";

function longestRun(text: string, character: string): number {
  let longest = 0;
  let run = 0;
  for (const current of text) {
    run = current === character ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

function findTrailingBlock(value: string, prefix: string, suffix: string) {
  if (!prefix || !suffix) return;
  const end = value.lastIndexOf(suffix);
  if (end < 0 || value.slice(end + suffix.length).trim()) return;

  const lastLineStart = value.lastIndexOf(`\n${prefix}`, end - prefix.length - 1);
  const start = lastLineStart >= 0 ? lastLineStart + 1 : 0;
  if (start + prefix.length > end || !value.startsWith(prefix, start)) return;
  return { before: value.slice(0, start), body: value.slice(start + prefix.length, end) };
}

export function insertWrappedDictation(
  value: string,
  text: string,
  { prefix, suffix, mergeConsecutive }: DictationWrapSettings,
): string {
  const openingRun = /^[`]{3,}|^~{3,}/.exec(prefix)?.[0];
  const closingRun = /[`]+$|~+$/.exec(suffix)?.[0];
  const fence = openingRun && openingRun === closingRun ? openingRun : undefined;

  let before = !value || value.endsWith("\n") ? value : `${value}\n`;
  let body = text;
  let minimumFenceLength = fence?.length ?? 0;

  if (mergeConsecutive && fence) {
    // A previous insertion may already have lengthened the configured fences.
    const actualClosingRun = /[`]+$|~+$/.exec(value.trimEnd())?.[0];
    if (actualClosingRun?.startsWith(fence)) {
      const block = findTrailingBlock(
        value,
        actualClosingRun + prefix.slice(fence.length),
        suffix.slice(0, -fence.length) + actualClosingRun,
      );
      if (block && longestRun(block.body, fence[0]) < actualClosingRun.length) {
        ({ before } = block);
        body = `${block.body} ${text}`;
        minimumFenceLength = actualClosingRun.length;
      }
    }
  } else if (mergeConsecutive) {
    const block = findTrailingBlock(value, prefix, suffix);
    if (block && !block.body.includes(suffix)) {
      ({ before } = block);
      body = `${block.body} ${text}`;
    }
  }

  if (fence) {
    const length = Math.max(minimumFenceLength, longestRun(body, fence[0]) + 1);
    const delimiter = fence[0].repeat(length);
    prefix = delimiter + prefix.slice(fence.length);
    suffix = suffix.slice(0, -fence.length) + delimiter;
  }
  return before + prefix + body + suffix;
}
