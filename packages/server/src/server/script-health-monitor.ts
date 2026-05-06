import net from "node:net";
import type { ScriptRouteEntry, ScriptRouteStore } from "./script-proxy.js";

export type ScriptHealthState = "pending" | "healthy" | "unhealthy";

export interface ScriptHealthEntry {
  scriptName: string;
  hostname: string;
  port: number;
  health: ScriptHealthState;
}

interface RouteHealthState {
  workspaceId: string;
  health: ScriptHealthState;
  consecutiveFailures: number;
  registeredAt: number;
}

export class ScriptHealthMonitor {
  private readonly routeStore: ScriptRouteStore;
  private readonly onChange: (workspaceId: string, scripts: ScriptHealthEntry[]) => void;
  private readonly pollIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly graceMs: number;
  private readonly failuresBeforeStopped: number;
  private readonly routeStates = new Map<string, RouteHealthState>();
  private readonly lastEmittedSnapshots = new Map<string, string>();

  private intervalHandle: NodeJS.Timeout | null = null;
  private pollInFlight = false;

  constructor({
    routeStore,
    onChange,
    pollIntervalMs = 3_000,
    probeTimeoutMs = 500,
    graceMs = 5_000,
    failuresBeforeStopped = 2,
  }: {
    routeStore: ScriptRouteStore;
    onChange: (workspaceId: string, scripts: ScriptHealthEntry[]) => void;
    pollIntervalMs?: number;
    probeTimeoutMs?: number;
    graceMs?: number;
    failuresBeforeStopped?: number;
  }) {
    this.routeStore = routeStore;
    this.onChange = onChange;
    this.pollIntervalMs = pollIntervalMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.graceMs = graceMs;
    this.failuresBeforeStopped = failuresBeforeStopped;
  }

  start(): void {
    if (this.intervalHandle) {
      return;
    }

    const now = Date.now();
    for (const route of this.routeStore.listRoutes()) {
      this.getOrCreateState(route, now);
    }

    this.intervalHandle = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  invalidateWorkspace(workspaceId: string): void {
    const scripts = this.buildWorkspaceScriptList(workspaceId);
    const snapshot = JSON.stringify(scripts);
    if (snapshot === this.lastEmittedSnapshots.get(workspaceId)) {
      return;
    }

    this.lastEmittedSnapshots.set(workspaceId, snapshot);
    this.onChange(workspaceId, scripts);
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }

    this.pollInFlight = true;
    try {
      const routes = this.routeStore.listRoutes();
      const activeHostnames = new Set(routes.map((route) => route.hostname));
      const changedWorkspaceIds = new Set<string>();
      const now = Date.now();

      const probeTargets = routes
        .map((route) => ({ route, state: this.getOrCreateState(route, now) }))
        .filter(({ state }) => now - state.registeredAt >= this.graceMs);
      const healthResults = await Promise.all(
        probeTargets.map(({ route }) => this.probeRoute(route.port)),
      );
      for (let i = 0; i < probeTargets.length; i += 1) {
        const { route, state } = probeTargets[i];
        const isHealthy = healthResults[i];
        const previousHealth = state.health;

        if (isHealthy) {
          state.consecutiveFailures = 0;
          state.health = "healthy";
        } else {
          state.consecutiveFailures += 1;
          if (state.consecutiveFailures >= this.failuresBeforeStopped) {
            state.health = "unhealthy";
          }
        }

        if (state.health !== previousHealth) {
          changedWorkspaceIds.add(route.workspaceId);
        }
      }

      this.pruneRemovedRoutes(activeHostnames);

      for (const workspaceId of changedWorkspaceIds) {
        const scripts = this.buildWorkspaceScriptList(workspaceId);
        const snapshot = JSON.stringify(scripts);
        if (snapshot === this.lastEmittedSnapshots.get(workspaceId)) {
          continue;
        }

        this.lastEmittedSnapshots.set(workspaceId, snapshot);
        this.onChange(workspaceId, scripts);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private getOrCreateState(
    route: Pick<ScriptRouteEntry, "hostname" | "workspaceId">,
    registeredAt: number,
  ): RouteHealthState {
    const existing = this.routeStates.get(route.hostname);
    if (existing) {
      return existing;
    }

    const state: RouteHealthState = {
      workspaceId: route.workspaceId,
      health: "pending",
      consecutiveFailures: 0,
      registeredAt,
    };
    this.routeStates.set(route.hostname, state);
    return state;
  }

  private pruneRemovedRoutes(activeHostnames: Set<string>): void {
    for (const [hostname, state] of this.routeStates.entries()) {
      if (activeHostnames.has(hostname)) {
        continue;
      }
      this.routeStates.delete(hostname);
      this.lastEmittedSnapshots.delete(state.workspaceId);
    }
  }

  private buildWorkspaceScriptList(workspaceId: string): ScriptHealthEntry[] {
    return this.routeStore.listRoutesForWorkspace(workspaceId).flatMap((route) => {
      const state = this.routeStates.get(route.hostname);
      if (!state) {
        return [];
      }
      return [this.toScriptHealthEntry(route, state.health)];
    });
  }

  getHealthForHostname(hostname: string): ScriptHealthState | null {
    const state = this.routeStates.get(hostname);
    if (state) {
      return state.health;
    }

    const route = this.routeStore.getRouteEntry(hostname);
    if (!route) {
      return null;
    }

    return this.getOrCreateState(route, Date.now()).health;
  }

  private toScriptHealthEntry(
    route: ScriptRouteEntry,
    health: ScriptHealthEntry["health"],
  ): ScriptHealthEntry {
    return {
      scriptName: route.scriptName,
      hostname: route.hostname,
      port: route.port,
      health,
    };
  }

  private probeRoute(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      let settled = false;

      const finish = (healthy: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(healthy);
      };

      socket.setTimeout(this.probeTimeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  }
}
