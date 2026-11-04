import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import type { ProjectNameTarget } from "./model";
import { joinDirectoryPath } from "./options";

export interface ProjectNameInput {
  target: ProjectNameTarget;
  name: string;
  defaultName: string;
}

export interface ApplyProjectDisplayNameInput {
  client: Pick<DaemonClient, "renameProject">;
  project: WorkspaceProjectDescriptorPayload;
  name: string | null;
}

export type ProjectNameChoice =
  | { kind: "default" }
  | { kind: "custom"; name: string }
  | { kind: "invalid"; error: string };

/**
 * An empty name or the prefilled one keeps the default, so the request stays
 * what it was before the step existed. Clone names become a folder and must be
 * one path segment; display names are free text.
 */
export function chooseProjectName(input: ProjectNameInput): ProjectNameChoice {
  const name = input.name.trim();
  if (!name || name === input.defaultName) return { kind: "default" };
  if (input.target.kind === "clone" && !isSinglePathSegment(name)) {
    return { kind: "invalid", error: "Enter a single folder name" };
  }
  return { kind: "custom", name };
}

export function projectNamePreview(input: ProjectNameInput): string {
  if (input.target.kind === "directory") return input.target.path;
  const name = input.name.trim() || input.defaultName;
  return joinDirectoryPath(input.target.parentPath, name);
}

function isSinglePathSegment(name: string): boolean {
  return name !== "." && name !== ".." && !/[\\/]/u.test(name) && !name.includes("\0");
}

/** Gives an added folder its chosen display name, unless it already has it. */
export async function applyProjectDisplayName(
  input: ApplyProjectDisplayNameInput,
): Promise<WorkspaceProjectDescriptorPayload> {
  if (input.name === null || input.name === input.project.projectDisplayName) {
    return input.project;
  }
  const { customName } = await input.client.renameProject(input.project.projectId, input.name);
  return {
    ...input.project,
    projectDisplayName: customName ?? input.project.projectDisplayName,
    projectCustomName: customName,
  };
}
