import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";

import type {
  DaemonConfigImportResponse,
  PortableDaemonConfiguration,
  PortableProjectIcon,
  PortableProjectConfiguration,
} from "@getpaseo/protocol/messages";

import { areEquivalentPaths } from "../../../utils/path.js";
import {
  getCustomProjectIcon,
  setCustomProjectIcon,
  type CustomProjectIconInput,
  type ProjectIcon,
} from "../../../utils/project-icon.js";
import {
  createPersistedProjectRecord,
  type PersistedProjectRecord,
  type ProjectRegistry,
} from "../../workspace-registry.js";

type ImportResult = Omit<DaemonConfigImportResponse["payload"], "requestId">;

export interface PortableConfigServiceOptions {
  paseoHome: string;
  projectRegistry: ProjectRegistry;
  homeDirectory?: string;
  now?: () => string;
  directoryExists?: (path: string) => Promise<boolean>;
}

function getHomeRelativePath(homeDirectory: string, rootPath: string): string | undefined {
  const relativePath = relative(homeDirectory, rootPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath.split(sep).join("/");
}

function resolveHomeRelativePath(
  homeDirectory: string,
  homeRelativePath: string | undefined,
): string | null {
  if (!homeRelativePath) return null;
  const segments = homeRelativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  const candidate = resolve(homeDirectory, ...segments);
  const relativeCandidate = relative(homeDirectory, candidate);
  if (
    relativeCandidate === "" ||
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${sep}`) ||
    isAbsolute(relativeCandidate)
  ) {
    return null;
  }
  return candidate;
}

async function defaultDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveImportedRootPath(input: {
  project: PortableProjectConfiguration;
  homeDirectory: string;
  directoryExists: (path: string) => Promise<boolean>;
}): Promise<string | null> {
  const candidates = [
    input.project.rootPath,
    resolveHomeRelativePath(input.homeDirectory, input.project.homeRelativePath),
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    if (await input.directoryExists(candidate)) return candidate;
  }
  return null;
}

function findActiveProjectByRoot(
  projects: readonly PersistedProjectRecord[],
  rootPath: string,
): PersistedProjectRecord | null {
  return (
    projects
      .filter((project) => !project.archivedAt && areEquivalentPaths(project.rootPath, rootPath))
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.projectId.localeCompare(right.projectId),
      )[0] ?? null
  );
}

function withImportedMetadata(input: {
  current: PersistedProjectRecord;
  imported: PortableProjectConfiguration;
  rootPath: string;
  updatedAt: string;
}): PersistedProjectRecord {
  return {
    ...input.current,
    rootPath: input.rootPath,
    kind: input.imported.kind,
    displayName: input.imported.displayName,
    customName: input.imported.customName,
    updatedAt: input.updatedAt,
    archivedAt: null,
  };
}

function toPortableProjectIcon(icon: ProjectIcon | null): PortableProjectIcon {
  if (!icon) return null;
  if (icon.emoji) return { kind: "emoji", emoji: icon.emoji };
  return { kind: "image", data: icon.data };
}

function toCustomProjectIconInput(icon: PortableProjectIcon): CustomProjectIconInput {
  if (!icon) return null;
  if (icon.kind === "emoji") return { emoji: icon.emoji };
  return icon.data;
}

export class PortableConfigService {
  private readonly paseoHome: string;
  private readonly projectRegistry: ProjectRegistry;
  private readonly homeDirectory: string;
  private readonly now: () => string;
  private readonly directoryExists: (path: string) => Promise<boolean>;

  constructor(options: PortableConfigServiceOptions) {
    this.paseoHome = options.paseoHome;
    this.projectRegistry = options.projectRegistry;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.now = options.now ?? (() => new Date().toISOString());
    this.directoryExists = options.directoryExists ?? defaultDirectoryExists;
  }

  async export(): Promise<PortableDaemonConfiguration> {
    const projects = (await this.projectRegistry.list())
      .filter((project) => !project.archivedAt)
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.projectId.localeCompare(right.projectId),
      );

    return {
      version: 1,
      exportedAt: this.now(),
      projects: await Promise.all(
        projects.map(async (project): Promise<PortableProjectConfiguration> => {
          const icon = await getCustomProjectIcon(this.paseoHome, project.rootPath);
          const portableProject: PortableProjectConfiguration = {
            projectId: project.projectId,
            rootPath: project.rootPath,
            kind: project.kind,
            displayName: project.displayName,
            customName: project.customName,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            customIcon: toPortableProjectIcon(icon),
          };
          const homeRelativePath = getHomeRelativePath(this.homeDirectory, project.rootPath);
          if (homeRelativePath) portableProject.homeRelativePath = homeRelativePath;
          return portableProject;
        }),
      ),
    };
  }

  async import(config: PortableDaemonConfiguration): Promise<ImportResult> {
    const result: ImportResult = {
      added: 0,
      updated: 0,
      skipped: 0,
      projectIdMap: {},
      rootPathMap: {},
      skippedProjects: [],
      iconErrors: [],
    };
    let currentProjects = await this.projectRegistry.list();

    for (const imported of config.projects) {
      const rootPath = await resolveImportedRootPath({
        project: imported,
        homeDirectory: this.homeDirectory,
        directoryExists: this.directoryExists,
      });
      if (!rootPath) {
        result.skipped += 1;
        result.skippedProjects.push({
          projectId: imported.projectId,
          rootPath: imported.rootPath,
          reason: "Project directory was not found on this machine.",
        });
        continue;
      }

      const timestamp = this.now();
      const activeAtRoot = findActiveProjectByRoot(currentProjects, rootPath);
      const projectWithImportedId =
        currentProjects.find((project) => project.projectId === imported.projectId) ?? null;
      let target: PersistedProjectRecord;

      if (activeAtRoot) {
        target = withImportedMetadata({
          current: activeAtRoot,
          imported,
          rootPath,
          updatedAt: timestamp,
        });
        await this.projectRegistry.upsert(target);
        result.updated += 1;
      } else if (
        projectWithImportedId &&
        areEquivalentPaths(projectWithImportedId.rootPath, rootPath)
      ) {
        target = withImportedMetadata({
          current: projectWithImportedId,
          imported,
          rootPath,
          updatedAt: timestamp,
        });
        await this.projectRegistry.upsert(target);
        result.updated += 1;
      } else if (projectWithImportedId) {
        const allocated = await this.projectRegistry.getOrCreateActiveByRoot({
          rootPath,
          kind: imported.kind,
          displayName: imported.displayName,
          timestamp,
        });
        target = withImportedMetadata({
          current: allocated,
          imported,
          rootPath,
          updatedAt: timestamp,
        });
        await this.projectRegistry.upsert(target);
        result.added += 1;
      } else {
        target = createPersistedProjectRecord({
          projectId: imported.projectId,
          rootPath,
          kind: imported.kind,
          displayName: imported.displayName,
          customName: imported.customName,
          createdAt: imported.createdAt,
          updatedAt: timestamp,
        });
        await this.projectRegistry.upsert(target);
        result.added += 1;
      }

      result.projectIdMap[imported.projectId] = target.projectId;
      result.rootPathMap[imported.rootPath] = rootPath;
      try {
        await setCustomProjectIcon(
          this.paseoHome,
          rootPath,
          toCustomProjectIconInput(imported.customIcon),
        );
      } catch (error) {
        result.iconErrors.push({
          projectId: target.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      currentProjects = await this.projectRegistry.list();
    }

    return result;
  }
}
