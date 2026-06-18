import http, { createServer as createHTTPServer } from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import express, { type RequestHandler } from "express";
import type { Logger } from "pino";

export type ServiceProxyListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

export interface ServiceProxyRoute {
  hostname: string;
  port: number;
}

export interface ServiceProxyRouteEntry extends ServiceProxyRoute {
  workspaceId: string;
  projectSlug: string;
  scriptName: string;
  localHostname?: string;
  publicHostname?: string | null;
  publicBaseUrl?: string | null;
}

export interface ServiceProxyUrlProjection {
  localProxyUrl: string | null;
  publicProxyUrl: string | null;
  proxyUrl: string | null;
}

export interface ServiceProxyScriptProjection extends ServiceProxyUrlProjection {
  hostname: string;
}

export interface ServiceProxyWorkspaceScriptProjection extends ServiceProxyScriptProjection {
  port: number | null;
}

export interface ServiceProxyHealthTarget {
  workspaceId: string;
  scriptName: string;
  hostname: string;
  port: number;
}

export interface WorkspaceServiceIdentity {
  workspaceId: string;
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
}

export interface RegisterWorkspaceServiceInput extends WorkspaceServiceIdentity {
  port: number;
  publicBaseUrl?: string | null;
}

interface HostClassificationRegistered {
  type: "registered-service";
  route: ServiceProxyRoute;
}

interface HostClassificationKnownMiss {
  type: "known-service-miss";
}

interface HostClassificationDaemon {
  type: "daemon";
}

type HostClassification =
  | HostClassificationRegistered
  | HostClassificationKnownMiss
  | HostClassificationDaemon;

const MAX_DNS_LABEL_LENGTH = 63;
const HASH_SUFFIX_LENGTH = 8;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

function normalizeHostHeader(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

function toHostnameLabel(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

function hashLabel(label: string): string {
  return createHash("sha256").update(label).digest("hex").slice(0, HASH_SUFFIX_LENGTH);
}

function capDnsLabel(label: string): string {
  if (label.length <= MAX_DNS_LABEL_LENGTH) {
    return label;
  }
  const suffix = hashLabel(label);
  const maxPrefixLength = MAX_DNS_LABEL_LENGTH - suffix.length - 2;
  const prefix = label.slice(0, maxPrefixLength).replace(/-+$/g, "") || "svc";
  return `${prefix}--${suffix}`;
}

export function buildServiceProxyLabel({
  projectSlug,
  branchName,
  scriptName,
}: {
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
}): string {
  const labels = [toHostnameLabel(scriptName)];
  const isDefaultBranch = branchName === null || branchName === "main" || branchName === "master";
  if (!isDefaultBranch) {
    labels.push(toHostnameLabel(branchName));
  }
  labels.push(toHostnameLabel(projectSlug));
  return capDnsLabel(labels.join("--"));
}

export function buildLocalServiceHostname(input: {
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
}): string {
  return `${buildServiceProxyLabel(input)}.localhost`;
}

export function buildPublicServiceHostname({
  publicBaseUrl,
  ...service
}: {
  publicBaseUrl: string;
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
}): string {
  const base = new URL(publicBaseUrl);
  return `${buildServiceProxyLabel(service)}.${base.hostname}`;
}

export function buildPublicServiceProxyUrl(options: {
  publicBaseUrl: string;
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
}): string {
  const base = new URL(options.publicBaseUrl);
  const hostname = buildPublicServiceHostname(options);
  const port = base.port ? `:${base.port}` : "";
  return `${base.protocol}//${hostname}${port}`;
}

export function projectServiceProxyUrls(options: {
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
  daemonPort: number | null | undefined;
  publicBaseUrl?: string | null;
}): ServiceProxyUrlProjection {
  const localHostname = buildLocalServiceHostname(options);
  const localProxyUrl =
    options.daemonPort === null || options.daemonPort === undefined
      ? null
      : `http://${localHostname}:${options.daemonPort}`;
  const publicProxyUrl = options.publicBaseUrl
    ? buildPublicServiceProxyUrl({
        projectSlug: options.projectSlug,
        branchName: options.branchName,
        scriptName: options.scriptName,
        publicBaseUrl: options.publicBaseUrl,
      })
    : null;
  return {
    localProxyUrl,
    publicProxyUrl,
    proxyUrl: publicProxyUrl ?? localProxyUrl,
  };
}

export function projectWorkspaceService(input: {
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
  daemonPort: number | null | undefined;
  publicBaseUrl?: string | null;
}): ServiceProxyScriptProjection {
  return {
    hostname: buildLocalServiceHostname(input),
    ...projectServiceProxyUrls(input),
  };
}

export function projectRegisteredServiceProxyUrls(options: {
  route: Pick<
    ServiceProxyRouteEntry,
    "hostname" | "publicHostname" | "publicBaseUrl" | "projectSlug" | "scriptName"
  >;
  daemonPort: number | null | undefined;
}): ServiceProxyUrlProjection {
  const localProxyUrl =
    options.daemonPort === null || options.daemonPort === undefined
      ? null
      : `http://${options.route.hostname}:${options.daemonPort}`;
  let publicProxyUrl: string | null = null;
  if (options.route.publicHostname && options.route.publicBaseUrl) {
    const base = new URL(options.route.publicBaseUrl);
    const port = base.port ? `:${base.port}` : "";
    publicProxyUrl = `${base.protocol}//${options.route.publicHostname}${port}`;
  }
  return {
    localProxyUrl,
    publicProxyUrl,
    proxyUrl: publicProxyUrl ?? localProxyUrl,
  };
}

function toHealthTarget(route: ServiceProxyRouteEntry): ServiceProxyHealthTarget {
  return {
    workspaceId: route.workspaceId,
    scriptName: route.scriptName,
    hostname: route.hostname,
    port: route.port,
  };
}

function stripHopByHopHeaders(
  rawHeaders: http.IncomingHttpHeaders,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function proxyHttpRequest({
  req,
  res,
  route,
  logger,
}: {
  req: Parameters<RequestHandler>[0];
  res: Parameters<RequestHandler>[1];
  route: ServiceProxyRoute;
  logger: Logger;
}): void {
  const hostHeader = req.headers.host ?? route.hostname;
  const forwardedHeaders = stripHopByHopHeaders(req.headers);
  forwardedHeaders["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
  forwardedHeaders["x-forwarded-host"] = String(hostHeader).replace(/:\d+$/, "");
  forwardedHeaders["x-forwarded-proto"] = req.protocol;

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: route.port,
      path: req.originalUrl,
      method: req.method,
      headers: forwardedHeaders,
    },
    (proxyRes) => {
      const responseHeaders = stripHopByHopHeaders(proxyRes.headers);
      res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
      proxyRes.pipe(res, { end: true });
    },
  );
  proxyReq.on("error", (err) => {
    logger.warn(
      { err, hostname: route.hostname, port: route.port },
      "Service proxy: upstream unreachable",
    );
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("502 Bad Gateway");
    }
  });
  req.pipe(proxyReq, { end: true });
}

function proxyUpgradeRequest({
  req,
  socket,
  head,
  route,
  logger,
}: {
  req: IncomingMessage;
  socket: net.Socket;
  head: Buffer;
  route: ServiceProxyRoute;
  logger: Logger;
}): void {
  const hostHeader = req.headers.host ?? route.hostname;
  const targetSocket = net.connect({ host: "127.0.0.1", port: route.port }, () => {
    const forwardedHeaders = stripHopByHopHeaders(req.headers);
    forwardedHeaders["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
    forwardedHeaders["x-forwarded-host"] = String(hostHeader).replace(/:\d+$/, "");
    forwardedHeaders["x-forwarded-proto"] = "http";
    forwardedHeaders.connection = "Upgrade";
    forwardedHeaders.upgrade = req.headers.upgrade ?? "websocket";

    const headerLines: string[] = [];
    headerLines.push(`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`);
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      if (Array.isArray(value)) {
        for (const v of value) headerLines.push(`${key}: ${v}`);
      } else {
        headerLines.push(`${key}: ${value}`);
      }
    }
    headerLines.push("\r\n");
    targetSocket.write(headerLines.join("\r\n"));
    if (head.length > 0) targetSocket.write(head);
    targetSocket.pipe(socket);
    socket.pipe(targetSocket);
  });
  targetSocket.on("error", (err) => {
    logger.warn(
      { err, hostname: route.hostname, port: route.port },
      "Service proxy: WebSocket upstream unreachable",
    );
    socket.end();
  });
  socket.on("error", () => {
    targetSocket.destroy();
  });
}

function sameRouteOwner(left: ServiceProxyRouteEntry, right: ServiceProxyRouteEntry): boolean {
  return left.workspaceId === right.workspaceId && left.scriptName === right.scriptName;
}

export class ServiceProxyRouteCollisionError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly existing: Pick<ServiceProxyRouteEntry, "workspaceId" | "scriptName">,
    public readonly incoming: Pick<ServiceProxyRouteEntry, "workspaceId" | "scriptName">,
  ) {
    super(
      `Another workspace is already serving "${incoming.scriptName}" at ${hostname}. Stop that service or run this one on a different branch to free the address.`,
    );
    this.name = "ServiceProxyRouteCollisionError";
  }
}

export class ServiceProxyRouteRegistry {
  private routes = new Map<string, ServiceProxyRouteEntry>();
  private hostnameAliases = new Map<string, string>();
  private workspaceHostnames = new Map<string, Set<string>>();
  private configuredPublicBaseHostnames = new Set<string>();
  private publicBaseHostnames = new Set<string>();

  constructor(publicBaseUrl?: string | null) {
    if (publicBaseUrl) {
      const hostname = new URL(publicBaseUrl).hostname.toLowerCase();
      this.configuredPublicBaseHostnames.add(hostname);
      this.publicBaseHostnames.add(hostname);
    }
  }

  registerWorkspaceService(input: RegisterWorkspaceServiceInput): ServiceProxyRouteEntry {
    const localHostname = buildLocalServiceHostname(input);
    const publicHostname = input.publicBaseUrl
      ? buildPublicServiceHostname({ ...input, publicBaseUrl: input.publicBaseUrl })
      : null;
    const entry: ServiceProxyRouteEntry = {
      hostname: localHostname,
      ...(publicHostname ? { publicHostname } : {}),
      ...(input.publicBaseUrl ? { publicBaseUrl: input.publicBaseUrl } : {}),
      port: input.port,
      workspaceId: input.workspaceId,
      projectSlug: input.projectSlug,
      scriptName: input.scriptName,
    };
    this.registerRoute(entry);
    return { ...entry };
  }

  registerRoute(entry: ServiceProxyRouteEntry): void {
    this.assertCanRegister(entry);
    const previous = this.routes.get(entry.hostname);
    if (previous) {
      this.removeRoute(previous.hostname);
    }
    const storedEntry = this.toStoredEntry(entry);
    this.routes.set(storedEntry.hostname, storedEntry);
    for (const alias of this.getRouteHostnames(storedEntry)) {
      this.hostnameAliases.set(alias, storedEntry.hostname);
    }
    if (storedEntry.publicBaseUrl) {
      this.publicBaseHostnames.add(new URL(storedEntry.publicBaseUrl).hostname.toLowerCase());
    }
    this.addHostnameToWorkspaceIndex(storedEntry.workspaceId, storedEntry.hostname);
  }

  replaceWorkspaceBranchRoutes(params: { workspaceId: string; newBranch: string | null }): boolean {
    const routes = this.listRoutesForWorkspace(params.workspaceId);
    if (routes.length === 0) {
      return false;
    }
    const updates = routes.map((route) => ({
      oldHostname: route.hostname,
      entry: this.toStoredEntry({
        ...route,
        hostname: buildLocalServiceHostname({
          projectSlug: route.projectSlug,
          branchName: params.newBranch,
          scriptName: route.scriptName,
        }),
        publicHostname: route.publicBaseUrl
          ? buildPublicServiceHostname({
              projectSlug: route.projectSlug,
              branchName: params.newBranch,
              scriptName: route.scriptName,
              publicBaseUrl: route.publicBaseUrl,
            })
          : null,
      }),
    }));

    if (
      updates.every(
        ({ oldHostname, entry }) =>
          oldHostname === entry.hostname &&
          (this.routes.get(oldHostname)?.publicHostname ?? null) === (entry.publicHostname ?? null),
      )
    ) {
      return false;
    }

    const replacingHostnames = new Set(routes.map((route) => route.hostname));
    this.assertNoInternalCollisions(updates.map(({ entry }) => entry));
    for (const { entry } of updates) {
      this.assertCanRegister(entry, replacingHostnames);
    }
    for (const { oldHostname } of updates) {
      this.removeRoute(oldHostname);
    }
    for (const { entry } of updates) {
      this.registerRoute(entry);
    }
    return true;
  }

  removeRoute(hostname: string): void {
    const canonicalHostname = this.hostnameAliases.get(normalizeHostHeader(hostname)) ?? hostname;
    const entry = this.routes.get(canonicalHostname);
    if (!entry) {
      return;
    }
    this.routes.delete(canonicalHostname);
    for (const alias of this.getRouteHostnames(entry)) {
      this.hostnameAliases.delete(alias);
    }
    this.removeHostnameFromWorkspaceIndex(entry.workspaceId, canonicalHostname);
    this.rebuildPublicBaseHostnames();
  }

  removeRouteForWorkspaceScript(params: { workspaceId: string; scriptName: string }): void {
    const route = this.listRoutesForWorkspace(params.workspaceId).find(
      (entry) => entry.scriptName === params.scriptName,
    );
    if (route) {
      this.removeRoute(route.hostname);
    }
  }

  removeWorkspaceService(params: { workspaceId: string; scriptName: string }): void {
    this.removeRouteForWorkspaceScript(params);
  }

  projectUrls(input: {
    projectSlug: string;
    branchName: string | null;
    scriptName: string;
    daemonPort: number | null | undefined;
    publicBaseUrl?: string | null;
  }): ServiceProxyUrlProjection {
    return projectServiceProxyUrls(input);
  }

  projectWorkspaceService(input: {
    projectSlug: string;
    branchName: string | null;
    scriptName: string;
    daemonPort: number | null | undefined;
    publicBaseUrl?: string | null;
  }): ServiceProxyScriptProjection {
    return projectWorkspaceService(input);
  }

  projectWorkspaceServiceState(input: {
    workspaceId: string;
    projectSlug: string;
    branchName: string | null;
    scriptName: string;
    daemonPort: number | null | undefined;
    publicBaseUrl?: string | null;
  }): ServiceProxyWorkspaceScriptProjection {
    const route = this.listRoutesForWorkspace(input.workspaceId).find(
      (entry) => entry.scriptName === input.scriptName,
    );
    if (route) {
      return {
        hostname: route.hostname,
        port: route.port,
        ...projectRegisteredServiceProxyUrls({ route, daemonPort: input.daemonPort }),
      };
    }
    return {
      port: null,
      ...projectWorkspaceService(input),
    };
  }

  getHealthCheckTargets(): ServiceProxyHealthTarget[] {
    return this.listRoutes().map(toHealthTarget);
  }

  getWorkspaceHealthTargets(workspaceId: string): ServiceProxyHealthTarget[] {
    return this.listRoutesForWorkspace(workspaceId).map(toHealthTarget);
  }

  getHealthTargetForHostname(hostname: string): ServiceProxyHealthTarget | null {
    const entry = this.getRouteEntry(hostname);
    return entry ? toHealthTarget(entry) : null;
  }

  removeServiceRoutesByHostnames(hostnames: string[]): void {
    for (const hostname of hostnames) {
      this.removeRoute(hostname);
    }
  }

  removeRoutesForPort(port: number): void {
    for (const [hostname, entry] of Array.from(this.routes)) {
      if (entry.port === port) {
        this.routes.delete(hostname);
        for (const alias of this.getRouteHostnames(entry)) {
          this.hostnameAliases.delete(alias);
        }
        this.removeHostnameFromWorkspaceIndex(entry.workspaceId, hostname);
      }
    }
    this.rebuildPublicBaseHostnames();
  }

  classifyHost(host: string | undefined): HostClassification {
    if (!host) {
      return { type: "daemon" };
    }
    const hostname = normalizeHostHeader(host);
    const exactRoute = this.getRouteByHostname(hostname);
    if (exactRoute) {
      return {
        type: "registered-service",
        route: { hostname: exactRoute.hostname, port: exactRoute.port },
      };
    }
    if (hostname.endsWith(".localhost") && hostname.split(".")[0]?.includes("--")) {
      return { type: "known-service-miss" };
    }
    for (const baseHostname of this.publicBaseHostnames) {
      if (hostname === baseHostname || hostname.endsWith(`.${baseHostname}`)) {
        return { type: "known-service-miss" };
      }
    }
    return { type: "daemon" };
  }

  findRoute(host: string): ServiceProxyRoute | null {
    const classification = this.classifyHost(host);
    return classification.type === "registered-service" ? classification.route : null;
  }

  getRouteEntry(hostname: string): ServiceProxyRouteEntry | null {
    const entry = this.getRouteByHostname(normalizeHostHeader(hostname));
    return entry ? { ...entry } : null;
  }

  listRoutes(): ServiceProxyRouteEntry[] {
    return Array.from(this.routes.values()).map((entry) => Object.assign({}, entry));
  }

  listRoutesForWorkspace(workspaceId: string): ServiceProxyRouteEntry[] {
    const hostnames = this.workspaceHostnames.get(workspaceId);
    if (!hostnames) {
      return [];
    }
    const routes: ServiceProxyRouteEntry[] = [];
    for (const hostname of hostnames) {
      const entry = this.routes.get(hostname);
      if (entry) {
        routes.push({ ...entry });
      }
    }
    return routes;
  }

  private assertCanRegister(
    entry: ServiceProxyRouteEntry,
    replacingHostnames = new Set<string>(),
  ): void {
    const incomingHostnames = this.getRouteHostnames(entry);
    for (const hostname of incomingHostnames) {
      const canonical = this.hostnameAliases.get(hostname) ?? hostname;
      if (replacingHostnames.has(canonical)) {
        continue;
      }
      const existing = this.routes.get(canonical);
      if (existing && !sameRouteOwner(existing, entry)) {
        throw new ServiceProxyRouteCollisionError(hostname, existing, entry);
      }
    }
  }

  private assertNoInternalCollisions(entries: ServiceProxyRouteEntry[]): void {
    const ownersByHostname = new Map<string, ServiceProxyRouteEntry>();
    for (const entry of entries) {
      for (const hostname of this.getRouteHostnames(entry)) {
        const existing = ownersByHostname.get(hostname);
        if (existing) {
          throw new ServiceProxyRouteCollisionError(hostname, existing, entry);
        }
        ownersByHostname.set(hostname, entry);
      }
    }
  }

  private toStoredEntry(entry: ServiceProxyRouteEntry): ServiceProxyRouteEntry {
    const { publicHostname, publicBaseUrl, ...requiredEntry } = entry;
    return {
      ...requiredEntry,
      ...(publicHostname ? { publicHostname } : {}),
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
    };
  }

  private getRouteByHostname(hostname: string): ServiceProxyRouteEntry | undefined {
    const canonicalHostname = this.hostnameAliases.get(hostname) ?? hostname;
    return this.routes.get(canonicalHostname);
  }

  private getRouteHostnames(
    entry: Pick<ServiceProxyRouteEntry, "hostname" | "publicHostname">,
  ): string[] {
    return [entry.hostname, ...(entry.publicHostname ? [entry.publicHostname] : [])].map((host) =>
      host.toLowerCase(),
    );
  }

  private addHostnameToWorkspaceIndex(workspaceId: string, hostname: string): void {
    const hostnames = this.workspaceHostnames.get(workspaceId) ?? new Set<string>();
    hostnames.add(hostname);
    this.workspaceHostnames.set(workspaceId, hostnames);
  }

  private removeHostnameFromWorkspaceIndex(workspaceId: string, hostname: string): void {
    const hostnames = this.workspaceHostnames.get(workspaceId);
    if (!hostnames) {
      return;
    }
    hostnames.delete(hostname);
    if (hostnames.size === 0) {
      this.workspaceHostnames.delete(workspaceId);
    }
  }

  private rebuildPublicBaseHostnames(): void {
    this.publicBaseHostnames = new Set(this.configuredPublicBaseHostnames);
    for (const entry of this.routes.values()) {
      if (entry.publicBaseUrl) {
        this.publicBaseHostnames.add(new URL(entry.publicBaseUrl).hostname.toLowerCase());
      }
    }
  }
}

export { ServiceProxyRouteRegistry as ScriptRouteStore };
export type ScriptRoute = ServiceProxyRoute;
export type ScriptRouteEntry = ServiceProxyRouteEntry;

export function createScriptProxyMiddleware({
  routeStore,
  logger,
}: {
  routeStore: ServiceProxyRouteRegistry;
  logger: Logger;
}): RequestHandler {
  return (req, res, next) => {
    const classification = routeStore.classifyHost(req.headers.host);
    if (classification.type === "daemon") {
      next();
      return;
    }
    if (classification.type === "known-service-miss") {
      res.status(404).send("404 Not Found");
      return;
    }
    proxyHttpRequest({ req, res, route: classification.route, logger });
  };
}

export function createScriptProxyUpgradeHandler({
  routeStore,
  logger,
  passthroughUnknown = true,
}: {
  routeStore: ServiceProxyRouteRegistry;
  logger: Logger;
  passthroughUnknown?: boolean;
}): (req: IncomingMessage, socket: net.Socket, head: Buffer) => void {
  return (req, socket, head) => {
    const classification = routeStore.classifyHost(req.headers.host);
    if (classification.type !== "registered-service") {
      if (!passthroughUnknown) {
        socket.destroy();
      }
      return;
    }
    proxyUpgradeRequest({ req, socket, head, route: classification.route, logger });
  };
}

export interface ServiceProxySubsystem {
  registerWorkspaceService(input: RegisterWorkspaceServiceInput): ServiceProxyRouteEntry;
  removeWorkspaceService(params: { workspaceId: string; scriptName: string }): void;
  removeServiceRoutesByHostnames(hostnames: string[]): void;
  replaceWorkspaceBranchRoutes(params: { workspaceId: string; newBranch: string | null }): boolean;
  getHealthCheckTargets(): ServiceProxyHealthTarget[];
  getWorkspaceHealthTargets(workspaceId: string): ServiceProxyHealthTarget[];
  getHealthTargetForHostname(hostname: string): ServiceProxyHealthTarget | null;
  projectUrls(input: {
    projectSlug: string;
    branchName: string | null;
    scriptName: string;
    daemonPort: number | null | undefined;
    publicBaseUrl?: string | null;
  }): ServiceProxyUrlProjection;
  projectWorkspaceService(input: {
    projectSlug: string;
    branchName: string | null;
    scriptName: string;
    daemonPort: number | null | undefined;
    publicBaseUrl?: string | null;
  }): ServiceProxyScriptProjection;
  projectWorkspaceServiceState(input: {
    workspaceId: string;
    projectSlug: string;
    branchName: string | null;
    scriptName: string;
    daemonPort: number | null | undefined;
    publicBaseUrl?: string | null;
  }): ServiceProxyWorkspaceScriptProjection;
  middleware(): RequestHandler;
  upgradeHandler(options: {
    passthroughUnknown: boolean;
  }): (req: IncomingMessage, socket: net.Socket, head: Buffer) => void;
  startStandalone(options: {
    listenTarget: ServiceProxyListenTarget;
  }): Promise<ServiceProxyListenTarget>;
  stopStandalone(): Promise<void>;
}

export function createServiceProxySubsystem({
  logger,
  publicBaseUrl,
}: {
  logger: Logger;
  publicBaseUrl?: string | null;
}): ServiceProxySubsystem {
  return new NodeServiceProxySubsystem(logger, publicBaseUrl ?? null);
}

class NodeServiceProxySubsystem implements ServiceProxySubsystem {
  private readonly routes: ServiceProxyRouteRegistry;
  private standaloneServer: ReturnType<typeof createHTTPServer> | null = null;
  private standaloneListenTarget: ServiceProxyListenTarget | null = null;

  constructor(
    private readonly logger: Logger,
    publicBaseUrl: string | null,
  ) {
    this.routes = new ServiceProxyRouteRegistry(publicBaseUrl);
  }

  registerWorkspaceService(input: RegisterWorkspaceServiceInput): ServiceProxyRouteEntry {
    return this.routes.registerWorkspaceService(input);
  }

  removeWorkspaceService(params: { workspaceId: string; scriptName: string }): void {
    this.routes.removeRouteForWorkspaceScript(params);
  }

  removeServiceRoutesByHostnames(hostnames: string[]): void {
    this.routes.removeServiceRoutesByHostnames(hostnames);
  }

  replaceWorkspaceBranchRoutes(params: { workspaceId: string; newBranch: string | null }): boolean {
    return this.routes.replaceWorkspaceBranchRoutes(params);
  }

  getHealthCheckTargets(): ServiceProxyHealthTarget[] {
    return this.routes.getHealthCheckTargets();
  }

  getWorkspaceHealthTargets(workspaceId: string): ServiceProxyHealthTarget[] {
    return this.routes.getWorkspaceHealthTargets(workspaceId);
  }

  getHealthTargetForHostname(hostname: string): ServiceProxyHealthTarget | null {
    return this.routes.getHealthTargetForHostname(hostname);
  }

  projectUrls(input: {
    projectSlug: string;
    branchName: string | null;
    scriptName: string;
    daemonPort: number | null | undefined;
    publicBaseUrl?: string | null;
  }): ServiceProxyUrlProjection {
    return projectServiceProxyUrls(input);
  }

  projectWorkspaceService(input: {
    projectSlug: string;
    branchName: string | null;
    scriptName: string;
    daemonPort: number | null | undefined;
    publicBaseUrl?: string | null;
  }): ServiceProxyScriptProjection {
    return projectWorkspaceService(input);
  }

  projectWorkspaceServiceState(input: {
    workspaceId: string;
    projectSlug: string;
    branchName: string | null;
    scriptName: string;
    daemonPort: number | null | undefined;
    publicBaseUrl?: string | null;
  }): ServiceProxyWorkspaceScriptProjection {
    return this.routes.projectWorkspaceServiceState(input);
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      const classification = this.routes.classifyHost(req.headers.host);
      if (classification.type === "daemon") {
        next();
        return;
      }
      if (classification.type === "known-service-miss") {
        res.status(404).send("404 Not Found");
        return;
      }
      this.proxyHttpRequest(req, res, classification.route);
    };
  }

  upgradeHandler(options: {
    passthroughUnknown: boolean;
  }): (req: IncomingMessage, socket: net.Socket, head: Buffer) => void {
    return (req, socket, head) => {
      const classification = this.routes.classifyHost(req.headers.host);
      if (classification.type !== "registered-service") {
        if (!options.passthroughUnknown) {
          socket.destroy();
        }
        return;
      }
      this.proxyUpgradeRequest(req, socket, head, classification.route);
    };
  }

  async startStandalone(options: {
    listenTarget: ServiceProxyListenTarget;
  }): Promise<ServiceProxyListenTarget> {
    if (this.standaloneServer) {
      return this.standaloneListenTarget ?? options.listenTarget;
    }
    const app = express();
    app.set("trust proxy", true);
    app.use(this.middleware());
    app.use((_req, res) => {
      res.status(404).send("404 Not Found");
    });
    const server = createHTTPServer(app);
    server.on("upgrade", this.upgradeHandler({ passthroughUnknown: false }));
    this.standaloneServer = server;
    try {
      await listen(server, options.listenTarget);
      this.standaloneListenTarget = resolveBoundListenTarget(options.listenTarget, server);
      return this.standaloneListenTarget;
    } catch (error) {
      this.standaloneServer = null;
      this.standaloneListenTarget = null;
      throw error;
    }
  }

  async stopStandalone(): Promise<void> {
    const server = this.standaloneServer;
    const listenTarget = this.standaloneListenTarget;
    this.standaloneServer = null;
    this.standaloneListenTarget = null;
    if (!server) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (listenTarget?.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
  }

  private proxyHttpRequest(
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
    route: ServiceProxyRoute,
  ): void {
    const hostHeader = req.headers.host ?? route.hostname;
    const forwardedHeaders = stripHopByHopHeaders(req.headers);
    forwardedHeaders["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
    forwardedHeaders["x-forwarded-host"] = String(hostHeader).replace(/:\d+$/, "");
    forwardedHeaders["x-forwarded-proto"] = req.protocol;

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: route.port,
        path: req.originalUrl,
        method: req.method,
        headers: forwardedHeaders,
      },
      (proxyRes) => {
        const responseHeaders = stripHopByHopHeaders(proxyRes.headers);
        res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        proxyRes.pipe(res, { end: true });
      },
    );
    proxyReq.on("error", (err) => {
      this.logger.warn(
        { err, hostname: route.hostname, port: route.port },
        "Service proxy: upstream unreachable",
      );
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("502 Bad Gateway");
      }
    });
    req.pipe(proxyReq, { end: true });
  }

  private proxyUpgradeRequest(
    req: IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    route: ServiceProxyRoute,
  ): void {
    const hostHeader = req.headers.host ?? route.hostname;
    const targetSocket = net.connect({ host: "127.0.0.1", port: route.port }, () => {
      const forwardedHeaders = stripHopByHopHeaders(req.headers);
      forwardedHeaders["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
      forwardedHeaders["x-forwarded-host"] = String(hostHeader).replace(/:\d+$/, "");
      forwardedHeaders["x-forwarded-proto"] = "http";
      forwardedHeaders.connection = "Upgrade";
      forwardedHeaders.upgrade = req.headers.upgrade ?? "websocket";

      const headerLines: string[] = [];
      headerLines.push(`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`);
      for (const [key, value] of Object.entries(forwardedHeaders)) {
        if (Array.isArray(value)) {
          for (const v of value) headerLines.push(`${key}: ${v}`);
        } else {
          headerLines.push(`${key}: ${value}`);
        }
      }
      headerLines.push("\r\n");
      targetSocket.write(headerLines.join("\r\n"));
      if (head.length > 0) targetSocket.write(head);
      targetSocket.pipe(socket);
      socket.pipe(targetSocket);
    });
    targetSocket.on("error", (err) => {
      this.logger.warn(
        { err, hostname: route.hostname, port: route.port },
        "Service proxy: WebSocket upstream unreachable",
      );
      socket.end();
    });
    socket.on("error", () => {
      targetSocket.destroy();
    });
  }
}

function listen(
  server: ReturnType<typeof createHTTPServer>,
  listenTarget: ServiceProxyListenTarget,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (listenTarget.type === "tcp") {
      server.listen(listenTarget.port, listenTarget.host);
    } else {
      if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
        unlinkSync(listenTarget.path);
      }
      server.listen(listenTarget.path);
    }
  });
}

function resolveBoundListenTarget(
  listenTarget: ServiceProxyListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ServiceProxyListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }
  return { type: "tcp", host: listenTarget.host, port: address.port };
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to get assigned port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}
