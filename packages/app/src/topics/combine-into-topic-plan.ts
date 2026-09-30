export type CombineIntoTopicChoice =
  | { kind: "new"; title: string }
  | { kind: "existing"; topicId: string };

export type CombineIntoTopicPlan =
  | { kind: "create"; title: string; workspaceIds: string[] }
  | { kind: "assign"; topicId: string; workspaceIds: string[] };

/** What submitting the dialog does, or null while there is nothing to submit. */
export function planCombineIntoTopic(input: {
  choice: CombineIntoTopicChoice;
  workspaceIds: readonly string[];
}): CombineIntoTopicPlan | null {
  const workspaceIds = [...new Set(input.workspaceIds)];
  if (workspaceIds.length === 0) return null;
  if (input.choice.kind === "existing") {
    return { kind: "assign", topicId: input.choice.topicId, workspaceIds };
  }
  const title = input.choice.title.trim();
  return title.length === 0 ? null : { kind: "create", title, workspaceIds };
}
