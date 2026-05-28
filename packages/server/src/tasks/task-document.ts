import { readFile, writeFile } from "node:fs/promises";
import type { Task, TaskStatus } from "./types.js";

function serializeTask(task: Task): string {
  const frontmatterLines = [
    "---",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `deps: [${task.deps.join(", ")}]`,
    `created: ${task.created}`,
  ];

  if (task.parentId) {
    frontmatterLines.push(`parentId: ${task.parentId}`);
  }

  if (task.assignee) {
    frontmatterLines.push(`assignee: ${task.assignee}`);
  }

  if (task.priority !== undefined) {
    frontmatterLines.push(`priority: ${task.priority}`);
  }

  frontmatterLines.push("---");

  const frontmatter = frontmatterLines.join("\n");

  let content = "";
  if (task.body) {
    content += task.body + "\n";
  }

  if (task.acceptanceCriteria.length > 0) {
    content += "\n## Acceptance Criteria\n\n";
    for (const criterion of task.acceptanceCriteria) {
      content += `- [ ] ${criterion}\n`;
    }
  }

  if (task.notes.length > 0) {
    content += "\n## Notes\n";
    for (const note of task.notes) {
      content += `\n**${note.timestamp}**\n\n${note.content}\n`;
    }
  }

  return frontmatter + "\n\n" + content;
}

function parseTask(content: string): Task {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    throw new Error("Invalid task file: missing frontmatter");
  }

  const frontmatter = frontmatterMatch[1];
  const fileBody = content.slice(frontmatterMatch[0].length);

  const getValue = (key: string): string => {
    const match = frontmatter.match(new RegExp(`^${key}: (.*)$`, "m"));
    return match ? match[1] : "";
  };

  const depsStr = getValue("deps");
  const depsMatch = depsStr.match(/\[(.*)\]/);
  const deps =
    depsMatch && depsMatch[1].trim()
      ? depsMatch[1]
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean)
      : [];

  const notes: Task["notes"] = [];
  const notesSection = fileBody.match(/## Notes\n([\s\S]*?)$/);
  if (notesSection) {
    const noteMatches = notesSection[1].matchAll(
      /\*\*(\d{4}-\d{2}-\d{2}T[\d:.Z]+)\*\*\n\n([\s\S]*?)(?=\n\*\*\d{4}|$)/g,
    );
    for (const match of noteMatches) {
      notes.push({
        timestamp: match[1],
        content: match[2].trim(),
      });
    }
  }

  const acceptanceCriteria: string[] = [];
  const criteriaSection = fileBody.match(/## Acceptance Criteria\n\n([\s\S]*?)(?=\n## Notes|$)/);
  if (criteriaSection) {
    const criteriaMatches = criteriaSection[1].matchAll(/- \[[ x]\] (.+)$/gm);
    for (const match of criteriaMatches) {
      acceptanceCriteria.push(match[1].trim());
    }
  }

  let taskBody = fileBody;
  const firstSection = fileBody.match(/\n## (Acceptance Criteria|Notes)\n/);
  if (firstSection) {
    taskBody = fileBody.slice(0, firstSection.index).trim();
  }
  taskBody = taskBody.trim();

  const assignee = getValue("assignee");
  const parentId = getValue("parentId");
  const priorityStr = getValue("priority");
  const priority = priorityStr ? parseInt(priorityStr, 10) : undefined;

  return {
    id: getValue("id"),
    title: getValue("title"),
    status: getValue("status") as TaskStatus,
    deps,
    parentId: parentId || undefined,
    body: taskBody,
    acceptanceCriteria,
    notes,
    created: getValue("created") || new Date().toISOString(),
    assignee: assignee || undefined,
    priority,
    raw: content,
  };
}

export async function readTaskDocument(filePath: string): Promise<Task> {
  const content = await readFile(filePath, "utf-8");
  return parseTask(content);
}

export async function writeTaskDocument(filePath: string, task: Task): Promise<void> {
  await writeFile(filePath, serializeTask(task), "utf-8");
}
