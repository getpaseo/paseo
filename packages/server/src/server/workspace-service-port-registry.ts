interface WorkspaceServicePortDeclaration {
  scriptName: string;
  port?: number;
}

interface WorkspaceServicePortAllocationRequest {
  scriptName: string;
  reservedPorts: ReadonlySet<number>;
}

interface EnsureWorkspaceServicePortPlanOptions {
  workspaceId: string;
  services: readonly WorkspaceServicePortDeclaration[];
  allocatePort: (request: WorkspaceServicePortAllocationRequest) => Promise<number>;
}

interface RefreshWorkspaceServicePortOptions {
  workspaceId: string;
  service: WorkspaceServicePortDeclaration;
  allocatePort: (request: WorkspaceServicePortAllocationRequest) => Promise<number>;
}

interface PendingWorkspaceServicePortPlanToken {
  isReleased: boolean;
}

const workspaceServicePortPlans = new Map<string, Map<string, number>>();
const pendingWorkspaceServicePortPlans = new Map<string, Promise<Map<string, number>>>();
const pendingWorkspaceServicePortPlanTokens = new Map<
  string,
  PendingWorkspaceServicePortPlanToken
>();
const dynamicPortOwners = new Map<number, string>();
const dynamicPortsByWorkspace = new Map<string, Map<string, number>>();
const MAX_DYNAMIC_PORT_ALLOCATION_ATTEMPTS = 10;

export async function ensureWorkspaceServicePortPlan(
  options: EnsureWorkspaceServicePortPlanOptions,
): Promise<ReadonlyMap<string, number>> {
  const pendingPlan = pendingWorkspaceServicePortPlans.get(options.workspaceId);
  if (pendingPlan) {
    await pendingPlan;
    return ensureWorkspaceServicePortPlan(options);
  }

  const existingPlan =
    workspaceServicePortPlans.get(options.workspaceId) ?? new Map<string, number>();
  if (options.services.every((service) => existingPlan.has(service.scriptName))) {
    return new Map(existingPlan);
  }

  return new Map(await startWorkspaceServicePortPlanUpdate({ ...options, existingPlan }));
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

export function releaseWorkspaceServicePortPlan(workspaceId: string): void {
  const pendingToken = pendingWorkspaceServicePortPlanTokens.get(workspaceId);
  if (pendingToken) pendingToken.isReleased = true;
  workspaceServicePortPlans.delete(workspaceId);
  const dynamicPorts = dynamicPortsByWorkspace.get(workspaceId);
  if (!dynamicPorts) return;

  for (const [scriptName, port] of dynamicPorts) {
    releaseDynamicPort({ workspaceId, scriptName, port });
  }
  dynamicPortsByWorkspace.delete(workspaceId);
}

interface WorkspaceServicePortPlanUpdateOptions extends EnsureWorkspaceServicePortPlanOptions {
  existingPlan: ReadonlyMap<string, number>;
  refreshScriptName?: string;
}

function startWorkspaceServicePortPlanUpdate(
  options: WorkspaceServicePortPlanUpdateOptions,
): Promise<Map<string, number>> {
  const token: PendingWorkspaceServicePortPlanToken = { isReleased: false };
  const plan = createPendingWorkspaceServicePortPlan({ ...options, token });
  pendingWorkspaceServicePortPlans.set(options.workspaceId, plan);
  pendingWorkspaceServicePortPlanTokens.set(options.workspaceId, token);
  return plan;
}

async function createPendingWorkspaceServicePortPlan(
  options: WorkspaceServicePortPlanUpdateOptions & { token: PendingWorkspaceServicePortPlanToken },
): Promise<Map<string, number>> {
  const previousDynamicPorts = new Map(dynamicPortsByWorkspace.get(options.workspaceId));
  const retainedPlan = new Map(options.existingPlan);
  if (options.refreshScriptName !== undefined) retainedPlan.delete(options.refreshScriptName);
  try {
    const updatedPlan = await buildWorkspaceServicePortPlan({
      workspaceId: options.workspaceId,
      services: options.services,
      allocatePort: options.allocatePort,
      existingPlan: retainedPlan,
    });
    const plan = new Map(options.existingPlan);
    for (const [scriptName, port] of updatedPlan) plan.set(scriptName, port);
    if (options.token.isReleased) {
      throw new Error(
        `Workspace service port plan was released while being created for '${options.workspaceId}'`,
      );
    }
    for (const [scriptName, port] of previousDynamicPorts) {
      if (plan.get(scriptName) !== port) {
        releaseDynamicPort({ workspaceId: options.workspaceId, scriptName, port });
      }
    }
    workspaceServicePortPlans.set(options.workspaceId, plan);
    return plan;
  } catch (error) {
    const dynamicPorts = dynamicPortsByWorkspace.get(options.workspaceId);
    if (dynamicPorts) {
      for (const [scriptName, port] of dynamicPorts) {
        if (previousDynamicPorts.get(scriptName) !== port) {
          releaseDynamicPort({ workspaceId: options.workspaceId, scriptName, port });
        }
      }
    }
    if (!options.token.isReleased) {
      for (const [scriptName, port] of previousDynamicPorts) {
        reserveDynamicPort({ workspaceId: options.workspaceId, scriptName, port });
      }
    }
    throw error;
  } finally {
    pendingWorkspaceServicePortPlans.delete(options.workspaceId);
    pendingWorkspaceServicePortPlanTokens.delete(options.workspaceId);
  }
}

async function buildWorkspaceServicePortPlan(options: {
  existingPlan: ReadonlyMap<string, number>;
  workspaceId: string;
  services: readonly WorkspaceServicePortDeclaration[];
  allocatePort: (request: WorkspaceServicePortAllocationRequest) => Promise<number>;
}): Promise<Map<string, number>> {
  const explicitPortOwners = new Map<number, string>(
    Array.from(options.existingPlan, ([scriptName, port]) => [port, scriptName]),
  );
  for (const service of options.services) {
    if (options.existingPlan.has(service.scriptName)) continue;
    if (service.port === undefined) continue;
    if (explicitPortOwners.has(service.port)) {
      throw new Error(`Service '${service.scriptName}' has a duplicate port ${service.port}`);
    }
    explicitPortOwners.set(service.port, service.scriptName);
  }

  const plan = new Map(options.existingPlan);
  for (const service of options.services) {
    if (plan.has(service.scriptName)) continue;
    if (service.port !== undefined) {
      plan.set(service.scriptName, service.port);
      continue;
    }
    const reservedPorts = new Set([...explicitPortOwners.keys(), ...plan.values()]);
    plan.set(
      service.scriptName,
      await resolveServicePort({
        service,
        workspaceId: options.workspaceId,
        allocatePort: options.allocatePort,
        reservedPorts,
      }),
    );
  }

  return plan;
}

export async function refreshWorkspaceServicePort(
  options: RefreshWorkspaceServicePortOptions,
): Promise<number> {
  const pendingPlan = pendingWorkspaceServicePortPlans.get(options.workspaceId);
  if (pendingPlan) {
    await pendingPlan;
    return refreshWorkspaceServicePort(options);
  }

  const plan = await startWorkspaceServicePortPlanUpdate({
    workspaceId: options.workspaceId,
    services: [options.service],
    allocatePort: options.allocatePort,
    existingPlan: workspaceServicePortPlans.get(options.workspaceId) ?? new Map<string, number>(),
    refreshScriptName: options.service.scriptName,
  });
  return requirePlannedWorkspaceServicePort(plan, options.service.scriptName);
}

async function resolveServicePort(options: {
  service: WorkspaceServicePortDeclaration;
  workspaceId: string;
  allocatePort: (request: WorkspaceServicePortAllocationRequest) => Promise<number>;
  reservedPorts: ReadonlySet<number>;
}): Promise<number> {
  const { service, workspaceId, allocatePort, reservedPorts } = options;
  if (service.port !== undefined) {
    if (reservedPorts.has(service.port)) {
      throw new Error(`Service '${service.scriptName}' has a duplicate port ${service.port}`);
    }
    return service.port;
  }

  for (let attempt = 0; attempt < MAX_DYNAMIC_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
    const unavailablePorts = new Set(reservedPorts);
    const serviceOwner = toServiceOwner(workspaceId, service.scriptName);
    for (const [port, owner] of dynamicPortOwners) {
      if (owner !== serviceOwner) unavailablePorts.add(port);
    }
    const port = await allocatePort({
      scriptName: service.scriptName,
      reservedPorts: unavailablePorts,
    });
    if (reservedPorts.has(port)) continue;
    const owner = dynamicPortOwners.get(port);
    if (owner !== undefined && owner !== serviceOwner) continue;
    reserveDynamicPort({ workspaceId, scriptName: service.scriptName, port });
    return port;
  }
  throw new Error(
    `Could not allocate a unique port for service '${service.scriptName}' after ${MAX_DYNAMIC_PORT_ALLOCATION_ATTEMPTS} attempts`,
  );
}

function reserveDynamicPort(options: {
  workspaceId: string;
  scriptName: string;
  port: number;
}): void {
  dynamicPortOwners.set(options.port, toServiceOwner(options.workspaceId, options.scriptName));
  const workspacePorts = dynamicPortsByWorkspace.get(options.workspaceId) ?? new Map();
  workspacePorts.set(options.scriptName, options.port);
  dynamicPortsByWorkspace.set(options.workspaceId, workspacePorts);
}

function releaseDynamicPort(options: {
  workspaceId: string;
  scriptName: string;
  port: number;
}): void {
  const owner = toServiceOwner(options.workspaceId, options.scriptName);
  if (dynamicPortOwners.get(options.port) === owner) {
    dynamicPortOwners.delete(options.port);
  }
  const workspacePorts = dynamicPortsByWorkspace.get(options.workspaceId);
  if (workspacePorts?.get(options.scriptName) === options.port) {
    workspacePorts.delete(options.scriptName);
    if (workspacePorts.size === 0) {
      dynamicPortsByWorkspace.delete(options.workspaceId);
    }
  }
}

function toServiceOwner(workspaceId: string, scriptName: string): string {
  return `${workspaceId}\0${scriptName}`;
}
