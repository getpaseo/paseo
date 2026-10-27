import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { OverviewSummary } from "./model";

function joinSummaryParts(parts: string[], conjunction: string): string {
  if (parts.length === 0) {
    return "";
  }
  let joined = parts[0] ?? "";
  if (parts.length === 2) {
    joined = `${parts[0]} ${conjunction} ${parts[1]}`;
  } else if (parts.length > 2) {
    joined = `${parts.slice(0, -1).join(", ")}, ${conjunction} ${parts.at(-1)}`;
  }
  const firstCharacter = joined[0];
  return firstCharacter ? `${firstCharacter.toLocaleUpperCase()}${joined.slice(1)}` : joined;
}

/**
 * One sentence of what a stretch of agent work did, such as "Edited 2 files and ran 3 commands".
 * Leading parts come first, for summaries that count more than tool calls.
 */
export function useOverviewSummaryLabel(
  summary: OverviewSummary,
  leadingParts: readonly string[] = [],
): string {
  const { t } = useTranslation();
  return useMemo(() => {
    const parts = [...leadingParts];
    const entries = [
      [summary.editedFileCount, "toolCallGroup.editedFiles"],
      [summary.commandCount, "toolCallGroup.commands"],
      [summary.readFileCount, "toolCallGroup.readFiles"],
      [summary.searchCount, "toolCallGroup.searches"],
      [summary.otherToolCount, "toolCallGroup.otherTools"],
    ] as const;
    for (const [count, key] of entries) {
      if (count > 0) {
        parts.push(t(`${key}.${count === 1 ? "one" : "other"}`, { count }));
      }
    }
    for (const [action, count] of Object.entries(summary.paseoActions)) {
      parts.push(
        count === 1 ? action.toLocaleLowerCase() : `${action.toLocaleLowerCase()} ×${count}`,
      );
    }
    if (summary.thoughtCount > 0) parts.push(t("toolCallGroup.thought").toLocaleLowerCase());
    return joinSummaryParts(parts, t("toolCallGroup.and"));
  }, [leadingParts, summary, t]);
}
