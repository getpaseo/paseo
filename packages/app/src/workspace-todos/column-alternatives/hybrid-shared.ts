import type { ReactNode } from "react";
import type { Task } from "./fixtures";

export interface HybridProps {
  tasks: Task[];
  renderTask: (task: Task) => ReactNode;
  renderCompleted: (tasks: Task[]) => ReactNode;
}

// Illustrative grouping, identical to the first Parcours proposal.
export const HYBRID_GROUPS = [
  { title: "Interactions & interface", short: "Interface", indices: [0, 1, 2] },
  { title: "Handoff & version locale", short: "Livraison", indices: [3, 4, 5, 6, 7] },
  { title: "Conversations interactives", short: "Conversations", indices: [8] },
];

export function groupTasks(tasks: Task[]) {
  const groups = HYBRID_GROUPS.map((group) => ({
    title: group.title,
    short: group.short,
    indices: group.indices,
    tasks: group.indices.map((i) => tasks[i]).filter(Boolean),
  }));
  if (tasks.length > 9)
    groups.push({ title: "À organiser", short: "À organiser", indices: [], tasks: tasks.slice(9) });
  return groups;
}
