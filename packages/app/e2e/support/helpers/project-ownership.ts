interface OwnedResourceResult {
  project?: { projectId: string } | null;
  workspace?: { projectId: string } | null;
}

interface ProjectClient {
  addProject?: (...args: unknown[]) => Promise<OwnedResourceResult>;
  close(): Promise<void>;
  createPaseoWorktree?: (...args: unknown[]) => Promise<OwnedResourceResult>;
  createWorkspace?: (...args: unknown[]) => Promise<OwnedResourceResult>;
  removeProject(projectId: string): Promise<unknown>;
}

/**
 * Makes a test client own every project it creates. Closing the client removes
 * those projects first, which also terminates their workspaces and terminals.
 */
export function withProjectOwnership<Client extends object>(client: Client): Client {
  const target = client as Client & ProjectClient;
  const projectIds = new Set<string>();
  let closed = false;

  async function trackProject(result: OwnedResourceResult) {
    const projectId = result.project?.projectId ?? result.workspace?.projectId;
    if (projectId) projectIds.add(projectId);
    return result;
  }

  return new Proxy(client, {
    get(_target, property) {
      if (property === "addProject" && target.addProject) {
        const addProject = target.addProject.bind(target);
        return async (...args: unknown[]) => trackProject(await addProject(...args));
      }
      if (property === "createWorkspace" && target.createWorkspace) {
        const createWorkspace = target.createWorkspace.bind(target);
        return async (...args: unknown[]) => trackProject(await createWorkspace(...args));
      }
      if (property === "createPaseoWorktree" && target.createPaseoWorktree) {
        const createPaseoWorktree = target.createPaseoWorktree.bind(target);
        return async (...args: unknown[]) => trackProject(await createPaseoWorktree(...args));
      }
      if (property === "removeProject") {
        return async (projectId: string) => {
          const result = await target.removeProject(projectId);
          projectIds.delete(projectId);
          return result;
        };
      }
      if (property === "close") {
        return async () => {
          if (closed) return;
          closed = true;
          for (const projectId of projectIds) {
            await target.removeProject(projectId).catch(() => undefined);
          }
          await target.close();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
