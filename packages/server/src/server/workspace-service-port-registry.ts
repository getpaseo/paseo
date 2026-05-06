interface WorkspaceServicePortDeclaration {
  scriptName: string;
  port?: number;
}

interface EnsureWorkspaceServicePortPlanOptions {
  workspaceId: string;
  services: readonly WorkspaceServicePortDeclaration[];
  allocatePort: () => Promise<number>;
}

interface RefreshWorkspaceServicePortOptions {
  workspaceId: string;
  service: WorkspaceServicePortDeclaration;
  allocatePort: () => Promise<number>;
}

const workspaceServicePortPlans = new Map<string, Map<string, number>>();
const pendingWorkspaceServicePortPlans = new Map<string, Promise<Map<string, number>>>();

export async function ensureWorkspaceServicePortPlan(
  options: EnsureWorkspaceServicePortPlanOptions,
): Promise<ReadonlyMap<string, number>> {
  const existingPlan = workspaceServicePortPlans.get(options.workspaceId);
  if (existingPlan) {
    return new Map(existingPlan);
  }

  let pendingPlan = pendingWorkspaceServicePortPlans.get(options.workspaceId);
  if (!pendingPlan) {
    pendingPlan = createPendingWorkspaceServicePortPlan({
      workspaceId: options.workspaceId,
      services: options.services,
      allocatePort: options.allocatePort,
    });
    pendingWorkspaceServicePortPlans.set(options.workspaceId, pendingPlan);
  }

  return new Map(await pendingPlan);
}

export function requirePlannedWorkspaceServicePort(
  plan: ReadonlyMap<string, number>,
  scriptName: string,
): number {
  const port = plan.get(scriptName);
  if (port === undefined) {
    throw new Error(`Service '${scriptName}' is missing from workspace service port plan`);
  }
  return port;
}

async function createPendingWorkspaceServicePortPlan(options: {
  workspaceId: string;
  services: readonly WorkspaceServicePortDeclaration[];
  allocatePort: () => Promise<number>;
}): Promise<Map<string, number>> {
  try {
    const plan = await buildWorkspaceServicePortPlan({
      services: options.services,
      allocatePort: options.allocatePort,
    });
    workspaceServicePortPlans.set(options.workspaceId, plan);
    return plan;
  } finally {
    pendingWorkspaceServicePortPlans.delete(options.workspaceId);
  }
}

async function buildWorkspaceServicePortPlan(options: {
  services: readonly WorkspaceServicePortDeclaration[];
  allocatePort: () => Promise<number>;
}): Promise<Map<string, number>> {
  const plan = new Map<string, number>();
  for (const service of options.services) {
    plan.set(service.scriptName, await resolveServicePort(service, options.allocatePort));
  }

  return plan;
}

export async function refreshWorkspaceServicePort(
  options: RefreshWorkspaceServicePortOptions,
): Promise<number> {
  const plan = workspaceServicePortPlans.get(options.workspaceId) ?? new Map<string, number>();

  const port = await resolveServicePort(options.service, options.allocatePort);
  plan.set(options.service.scriptName, port);
  workspaceServicePortPlans.set(options.workspaceId, plan);
  return port;
}

async function resolveServicePort(
  service: WorkspaceServicePortDeclaration,
  allocatePort: () => Promise<number>,
): Promise<number> {
  if (service.port !== undefined) {
    return service.port;
  }

  return await allocatePort();
}
