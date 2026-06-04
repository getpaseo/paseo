import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  buildLocalServiceHostname,
  buildPublicServiceHostname,
  buildServiceProxyLabel,
  createServiceProxySubsystem,
  findFreePort,
  ServiceProxyRouteRegistry,
} from "./service-proxy.js";

const logger = pino({ level: "silent" });

function readServerSourceFiles(dir = path.resolve(import.meta.dirname)): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...readServerSourceFiles(fullPath));
    } else if (fullPath.endsWith(".ts") && !fullPath.endsWith(".test.ts")) {
      entries.push(fullPath);
    }
  }
  return entries;
}

function httpGet(port: number, host: string, requestPath = "/api/health") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: requestPath, headers: { host } },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
  });
}

describe("service proxy subsystem shape", () => {
  it("keeps production imports behind the service-proxy entrypoint", () => {
    const offenders: string[] = [];
    for (const filePath of readServerSourceFiles()) {
      if (filePath.endsWith("service-proxy.ts") || filePath.endsWith("script-proxy.ts")) {
        continue;
      }
      const source = readFileSync(filePath, "utf8");
      for (const needle of ["./script-proxy.js", "../utils/script-hostname.js"]) {
        if (source.includes(needle)) {
          offenders.push(`${path.relative(import.meta.dirname, filePath)} imports ${needle}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("classifies the configured public namespace before any route exists", async () => {
    const serviceProxy = createServiceProxySubsystem({
      logger,
      publicBaseUrl: "https://services.example.com",
    });
    const port = await findFreePort();
    const app = express();
    app.use(serviceProxy.middleware());
    app.use((_req, res) => {
      res.status(200).send("daemon-api");
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await expect(httpGet(port, `missing.services.example.com:${port}`)).resolves.toEqual({
        status: 404,
        body: "404 Not Found",
      });
      await expect(httpGet(port, `daemon.localhost:${port}`)).resolves.toEqual({
        status: 200,
        body: "daemon-api",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps configured public namespace classified after the last public route is removed", async () => {
    const serviceProxy = createServiceProxySubsystem({
      logger,
      publicBaseUrl: "https://services.example.com",
    });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 3000,
      publicBaseUrl: "https://services.example.com",
    });
    serviceProxy.removeWorkspaceService({ workspaceId: "workspace-a", scriptName: "api" });

    const port = await findFreePort();
    const app = express();
    app.use(serviceProxy.middleware());
    app.use((_req, res) => {
      res.status(200).send("daemon-api");
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await expect(httpGet(port, `missing.services.example.com:${port}`)).resolves.toEqual({
        status: 404,
        body: "404 Not Found",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses the same hash-truncated service label for local and public hostnames", () => {
    const input = {
      projectSlug: "project-".repeat(10),
      branchName: "branch-".repeat(10),
      scriptName: "script-".repeat(10),
    };
    const label = buildServiceProxyLabel(input);

    expect(label.length).toBeLessThanOrEqual(63);
    expect(label.endsWith("-")).toBe(false);
    expect(buildLocalServiceHostname(input)).toBe(`${label}.localhost`);
    expect(
      buildPublicServiceHostname({ ...input, publicBaseUrl: "https://services.example.com" }),
    ).toBe(`${label}.services.example.com`);
    expect(buildServiceProxyLabel(input)).toBe(label);
    expect(
      buildServiceProxyLabel({ ...input, scriptName: `different-${input.scriptName}` }),
    ).not.toBe(label);
  });

  it("gives long labels with the same prefix different hash suffixes", () => {
    const sharedPrefix = "service-".repeat(12);
    const first = buildServiceProxyLabel({
      projectSlug: "repo",
      branchName: "feature/shared-prefix",
      scriptName: `${sharedPrefix}alpha`,
    });
    const second = buildServiceProxyLabel({
      projectSlug: "repo",
      branchName: "feature/shared-prefix",
      scriptName: `${sharedPrefix}beta`,
    });

    expect(first).not.toBe(second);
    expect(first.slice(0, -10)).toBe(second.slice(0, -10));
    expect(first.split("--").at(-1)).not.toBe(second.split("--").at(-1));
  });

  it("rejects cross-service collisions without deleting the existing route", () => {
    const serviceProxy = createServiceProxySubsystem({ logger });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 3000,
    });

    expect(() =>
      serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-b",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "api",
        port: 4000,
      }),
    ).toThrow("Service proxy hostname collision");

    expect(serviceProxy.getHealthTargetForHostname("api--repo.localhost")).toMatchObject({
      workspaceId: "workspace-a",
      port: 3000,
    });
  });

  it("rejects public alias collisions without deleting the existing route", () => {
    const serviceProxy = createServiceProxySubsystem({ logger });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 3000,
      publicBaseUrl: "https://services.example.com",
    });

    expect(() =>
      serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-b",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "api",
        port: 4000,
        publicBaseUrl: "https://services.example.com",
      }),
    ).toThrow("Service proxy hostname collision");

    expect(serviceProxy.getHealthTargetForHostname("api--repo.services.example.com")).toMatchObject(
      {
        workspaceId: "workspace-a",
        port: 3000,
      },
    );
  });

  it("rejects public alias collisions even when canonical hostnames differ", () => {
    const serviceProxy = new ServiceProxyRouteRegistry();
    serviceProxy.registerRoute({
      hostname: "api--repo-a.localhost",
      publicHostname: "api.services.example.com",
      publicBaseUrl: "https://services.example.com",
      port: 3000,
      workspaceId: "workspace-a",
      projectSlug: "repo-a",
      scriptName: "api",
    });

    expect(() =>
      serviceProxy.registerRoute({
        hostname: "api--repo-b.localhost",
        publicHostname: "api.services.example.com",
        publicBaseUrl: "https://services.example.com",
        port: 4000,
        workspaceId: "workspace-b",
        projectSlug: "repo-b",
        scriptName: "api",
      }),
    ).toThrow("Service proxy hostname collision");

    expect(serviceProxy.getRouteEntry("api--repo-a.localhost")).toMatchObject({ port: 3000 });
    expect(serviceProxy.getRouteEntry("api--repo-b.localhost")).toBeNull();
  });

  it("rejects canonical-to-public-alias collisions", () => {
    const serviceProxy = new ServiceProxyRouteRegistry();
    serviceProxy.registerRoute({
      hostname: "api--repo.localhost",
      publicHostname: "api.services.example.com",
      publicBaseUrl: "https://services.example.com",
      port: 3000,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "api",
    });

    expect(() =>
      serviceProxy.registerRoute({
        hostname: "api.services.example.com",
        port: 4000,
        workspaceId: "workspace-b",
        projectSlug: "other",
        scriptName: "api",
      }),
    ).toThrow("Service proxy hostname collision");

    expect(serviceProxy.getRouteEntry("api--repo.localhost")).toMatchObject({ port: 3000 });
    expect(serviceProxy.getRouteEntry("api.services.example.com")).toMatchObject({ port: 3000 });
  });

  it("allows same workspace/script replacement", () => {
    const serviceProxy = createServiceProxySubsystem({ logger });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 3000,
    });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 4000,
    });

    expect(serviceProxy.getHealthTargetForHostname("api--repo.localhost")).toMatchObject({
      port: 4000,
    });
  });
});
