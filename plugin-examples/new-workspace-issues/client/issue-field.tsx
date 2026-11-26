import { useCallback, useMemo } from "react";
import { useNewWorkspace, useRpc } from "@getpaseo/plugin/client";
import { Combobox } from "@getpaseo/plugin/client/ui";
import { searchIssuesRpc, type Issue } from "../shared/issues";

const ISSUE_KEY = "new-workspace-issues.issue";

/** Starts the workspace on the issue's branch and records which issue it is for. */
export function IssueField() {
  const newWorkspace = useNewWorkspace();
  const searchIssues = useRpc(searchIssuesRpc);
  const issueId = newWorkspace.metadata[ISSUE_KEY];
  const value = useMemo(
    () => (typeof issueId === "string" ? { id: issueId, label: issueId } : null),
    [issueId],
  );
  const search = useCallback(
    async ({ query }: { query: string }) => (await searchIssues({ query })).issues,
    [searchIssues],
  );
  const select = useCallback(
    async ({ item }: { item: Issue }) => {
      await newWorkspace.setBranch(item.branch);
      await newWorkspace.setMetadata({ [ISSUE_KEY]: item.id });
    },
    [newWorkspace],
  );
  return (
    <Combobox title="Issue" icon="CircleDot" value={value} search={search} onSelect={select} />
  );
}
