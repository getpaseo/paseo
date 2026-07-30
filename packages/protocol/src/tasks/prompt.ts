export const BACKLOG_TASK_ID_LABEL = "paseo.backlog-task-id";
export const BACKLOG_PROJECT_ID_LABEL = "paseo.backlog-project-id";

export interface BacklogTaskPromptSource {
  id: string;
  projectId: string;
  title: string;
  description: string;
}

export interface BacklogTaskReference {
  id: string;
  projectId: string;
}

export function formatBacklogTaskResolutionFooter(task: BacklogTaskReference): string {
  return [
    "---",
    `Backlog task ID: ${task.id}`,
    `Backlog project ID: ${task.projectId}`,
    `When this work is complete, mark the backlog task resolved with resolve_backlog_task (taskId: ${task.id}).`,
  ].join("\n");
}

export function appendBacklogTaskResolutionFooter(
  prompt: string,
  task: BacklogTaskReference,
): string {
  const trimmed = prompt.trim();
  const footer = formatBacklogTaskResolutionFooter(task);
  return trimmed.length > 0 ? `${trimmed}\n\n${footer}` : footer;
}

export function formatBacklogTaskWorkspacePrompt(task: BacklogTaskPromptSource): string {
  const title = task.title.trim();
  const description = task.description.trim();
  const body = description.length > 0 ? `${title}\n\n${description}` : title;
  return appendBacklogTaskResolutionFooter(body, task);
}

export function buildBacklogTaskLabels(task: BacklogTaskReference): Record<string, string> {
  return {
    [BACKLOG_TASK_ID_LABEL]: task.id,
    [BACKLOG_PROJECT_ID_LABEL]: task.projectId,
  };
}
