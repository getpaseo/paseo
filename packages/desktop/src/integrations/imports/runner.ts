import { randomUUID } from "node:crypto";
import type {
  ImportEvent,
  ImportResult,
  ImportSourceInput,
  PaseoImportHost,
  RunImportOptions,
} from "@getpaseo/import";

export interface ImportTarget {
  status: "starting" | "running" | "stopped" | "errored";
  desktopManaged: boolean;
  listen: string | null;
  home: string;
  appVersion: string;
  daemonVersion: string | null;
  passwordProtected: boolean;
}

export type DesktopImportOutput =
  | { runId: string; type: "event"; event: ImportEvent }
  | { runId: string; type: "status"; succeeded: boolean };

export type ImportUnavailableReason =
  | "unsupported-source"
  | "host-not-running"
  | "nonlocal-host"
  | "password-protected"
  | "host-version-mismatch"
  | "unavailable";

type ConnectedImportHost = PaseoImportHost & { close(): Promise<void> };

interface ImportRunnerDependencies {
  sources: ReadonlyMap<string, ImportSourceInput>;
  getTarget(): Promise<ImportTarget>;
  connect(target: ImportTarget): Promise<ConnectedImportHost>;
  runImport(options: RunImportOptions): Promise<ImportResult>;
  createRunId?(): string;
}

export class DesktopImportRunner {
  private activeRunId: string | null = null;

  constructor(private readonly dependencies: ImportRunnerDependencies) {}

  async availability(
    sourceId: string,
  ): Promise<{ available: boolean; reason: ImportUnavailableReason | null }> {
    try {
      this.requireSource(sourceId);
      assertEligibleTarget(await this.dependencies.getTarget());
      return { available: true, reason: null };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof ImportEligibilityError ? error.reason : "unavailable",
      };
    }
  }

  async run(sourceId: string, emit: (output: DesktopImportOutput) => void): Promise<string> {
    const source = this.requireSource(sourceId);
    if (this.activeRunId) throw new Error("An import is already running.");
    this.activeRunId = "starting";
    try {
      const target = await this.dependencies.getTarget();
      assertEligibleTarget(target);
      const host = await this.dependencies.connect(target);
      const runId = this.dependencies.createRunId?.() ?? randomUUID();
      this.activeRunId = runId;
      void this.execute({ runId, source, host, emit });
      return runId;
    } catch (error) {
      this.activeRunId = null;
      throw error;
    }
  }

  private async execute(input: {
    runId: string;
    source: ImportSourceInput;
    host: ConnectedImportHost;
    emit(output: DesktopImportOutput): void;
  }): Promise<void> {
    let succeeded = false;
    try {
      const result = await this.dependencies.runImport({
        source: input.source,
        host: input.host,
        onEvent: (event) => input.emit({ runId: input.runId, type: "event", event }),
      });
      succeeded = !result.notices.some((notice) => notice.level === "error");
    } catch (error) {
      input.emit({
        runId: input.runId,
        type: "event",
        event: {
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      await input.host.close().catch(() => undefined);
      this.activeRunId = null;
      input.emit({ runId: input.runId, type: "status", succeeded });
    }
  }

  private requireSource(sourceId: string): ImportSourceInput {
    const source = this.dependencies.sources.get(sourceId);
    if (!source) {
      throw new ImportEligibilityError(
        "unsupported-source",
        `Unsupported import source: ${sourceId}`,
      );
    }
    return source;
  }
}

export function assertEligibleTarget(target: ImportTarget): void {
  if (target.status !== "running" || !target.desktopManaged) {
    throw new ImportEligibilityError(
      "host-not-running",
      "Import requires the running Paseo Desktop-managed host.",
    );
  }
  if (!isLocalListen(target.listen)) {
    throw new ImportEligibilityError("nonlocal-host", "Import is unavailable for a nonlocal host.");
  }
  if (target.passwordProtected) {
    throw new ImportEligibilityError(
      "password-protected",
      "Import is unavailable while the local host is password-protected.",
    );
  }
  if (normalizeVersion(target.daemonVersion) !== normalizeVersion(target.appVersion)) {
    throw new ImportEligibilityError(
      "host-version-mismatch",
      "Update the Desktop-managed host before importing.",
    );
  }
}

class ImportEligibilityError extends Error {
  constructor(
    readonly reason: ImportUnavailableReason,
    message: string,
  ) {
    super(message);
  }
}

function isLocalListen(listen: string | null): boolean {
  if (!listen) return false;
  if (listen.startsWith("unix://") || listen.startsWith("pipe://") || listen.startsWith("/")) {
    return true;
  }
  const endpoint = listen.replace(/^tcp:\/\//, "").toLowerCase();
  if (endpoint.startsWith("[::1]:") || endpoint.startsWith("::1:")) return true;
  const host = endpoint.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function normalizeVersion(version: string | null): string | null {
  return version?.trim().replace(/^v/i, "") || null;
}
