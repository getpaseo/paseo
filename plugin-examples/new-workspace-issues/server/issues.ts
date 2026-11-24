import type { RpcInput } from "@getpaseo/plugin";
import { searchIssuesRpc, type Issue } from "../shared/issues";

// A real plugin would ask its tracker. A fixed list keeps the example self-contained.
const ISSUES: Issue[] = [
  {
    id: "PAS-101",
    label: "PAS-101 Slow sidebar",
    description: "Lists lag at 200 rows",
    branch: "pas-101-slow-sidebar",
  },
  {
    id: "PAS-102",
    label: "PAS-102 Crash on resume",
    description: "Agent resume throws",
    branch: "pas-102-crash-on-resume",
  },
  { id: "PAS-103", label: "PAS-103 Dark theme contrast", branch: "pas-103-dark-theme-contrast" },
];

export async function searchIssues({ query }: RpcInput<typeof searchIssuesRpc>) {
  const needle = query.trim().toLowerCase();
  return {
    issues: ISSUES.filter((issue) => issue.label.toLowerCase().includes(needle)),
  };
}
