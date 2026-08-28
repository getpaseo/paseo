import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import type { OutputSchema } from "../../output/index.js";

export interface ProjectRow {
  projectId: string;
  name: string;
  kind: "git" | "non_git" | "directory";
  path: string;
}

export const projectSchema: OutputSchema<ProjectRow> = {
  idField: "projectId",
  columns: [
    { header: "PROJECT ID", field: "projectId", width: 20 },
    { header: "NAME", field: "name", width: 24 },
    { header: "KIND", field: "kind", width: 10 },
    { header: "PATH", field: "path", width: 42 },
  ],
};

export function toProjectRow(project: WorkspaceProjectDescriptorPayload): ProjectRow {
  return {
    projectId: project.projectId,
    name: project.projectDisplayName,
    kind: project.projectKind,
    path: project.projectRootPath,
  };
}
