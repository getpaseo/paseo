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
  while (true) {
    const existingPlan = workspaceServicePortPlans.get(options.workspaceId);
    if (existingPlan && planMatchesServiceDeclarations(existingPlan, options.services)) {
      return new Map(existingPlan);
    }

    let pendingPlan = pendingWorkspaceServicePortPlans.get(options.workspaceId);
    if (!pendingPlan) {
      pendingPlan = createPendingWorkspaceServicePortPlan({
        workspaceId: options.workspaceId,
        existingPlan,
        services: options.services,
        allocatePort: options.allocatePort,
      });
      pendingWorkspaceServicePortPlans.set(options.workspaceId, pendingPlan);
      return new Map(await pendingPlan);
    }

    await pendingPlan;
  }
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
  existingPlan: ReadonlyMap<string, number> | undefined;
  services: readonly WorkspaceServicePortDeclaration[];
  allocatePort: () => Promise<number>;
}): Promise<Map<string, number>> {
  try {
    const plan = await buildWorkspaceServicePortPlan({
      existingPlan: options.existingPlan,
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
  existingPlan: ReadonlyMap<string, number> | undefined;
  services: readonly WorkspaceServicePortDeclaration[];
  allocatePort: () => Promise<number>;
}): Promise<Map<string, number>> {
  const plan = new Map<string, number>();
  for (const service of options.services) {
    const port = await resolvePlannedServicePort({
      service,
      existingPlan: options.existingPlan,
      allocatePort: options.allocatePort,
    });
    plan.set(service.scriptName, port);
  }

  return plan;
}

function planMatchesServiceDeclarations(
  plan: ReadonlyMap<string, number>,
  services: readonly WorkspaceServicePortDeclaration[],
): boolean {
  const serviceNames = new Set(services.map((service) => service.scriptName));
  if (plan.size !== serviceNames.size) {
    return false;
  }
  return services.every((service) => {
    const plannedPort = plan.get(service.scriptName);
    if (plannedPort === undefined) {
      return false;
    }
    return service.port === undefined || service.port === plannedPort;
  });
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

async function resolvePlannedServicePort(options: {
  service: WorkspaceServicePortDeclaration;
  existingPlan: ReadonlyMap<string, number> | undefined;
  allocatePort: () => Promise<number>;
}): Promise<number> {
  if (options.service.port !== undefined) {
    return options.service.port;
  }

  const existingPort = options.existingPlan?.get(options.service.scriptName);
  if (existingPort !== undefined) {
    return existingPort;
  }

  return await options.allocatePort();
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
