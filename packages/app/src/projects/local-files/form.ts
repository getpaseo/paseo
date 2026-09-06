import { Buffer } from "buffer";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  LOCAL_FILE_MAX_BYTES,
  LOCAL_FILE_AUTOSELECT_BYTES,
  LOCAL_FILES_MAX_BYTES,
  LOCAL_FILES_MAX_COUNT,
  type LocalFileInfo,
} from "@getpaseo/protocol/project-local-files";
import type { PaseoConfigRaw, PaseoConfigRevision } from "@getpaseo/protocol/messages";
import type { LocalFileSelection } from "./picker-types";

type LocalFilesClient = Pick<
  DaemonClient,
  | "inspectProjectLocalFiles"
  | "readProjectLocalFile"
  | "importProjectLocalFile"
  | "readProjectConfig"
  | "writeProjectConfig"
>;
export interface LocalFilesTarget {
  serverId: string;
  client: LocalFilesClient;
  projectId: string;
  root: string;
  label: string;
}
export type FormError =
  | "selection_invalid"
  | "load_failed"
  | "no_source_files"
  | "changed"
  | "import_failed"
  | "partial_failure"
  | "config_failed"
  | "secure_connection_required";
export interface ImportRow {
  path: string;
  size: number;
  sourceStatus: LocalFileInfo["status"];
  destination: LocalFileInfo;
  selected: boolean;
  status: "ready" | "too_large" | "unavailable" | "imported" | "failed";
  error: FormError | null;
}
export interface LocalFilesFormState {
  phase: "empty" | "loading" | "review" | "importing" | "complete";
  sourceLabel: string | null;
  rows: ImportRow[];
  includeInWorktrees: boolean;
  includedPaths: string[];
  selectedCount: number;
  selectedBytes: number;
  canSubmit: boolean;
  limitExceeded: boolean;
  configNeedsRefresh: boolean;
  error: FormError | null;
}
export type LocalFilesForm = ReturnType<typeof openLocalFilesForm>;

export function preselectLocalFiles(rows: ImportRow[]): ImportRow[] {
  let total = 0;
  return rows.map((row) => {
    const selected =
      row.status === "ready" &&
      row.destination.status === "missing" &&
      row.size <= LOCAL_FILE_AUTOSELECT_BYTES &&
      total + row.size <= 10 * 1024 * 1024;
    if (selected) total += row.size;
    return { ...row, selected };
  });
}

function toImportError(error: unknown): FormError {
  if (error instanceof Error) {
    if (error.message === "changed") return "changed";
    if (error.message === "secure_connection_required") return "secure_connection_required";
  }
  return "import_failed";
}

export function openLocalFilesForm(target: LocalFilesTarget) {
  const listeners = new Set<() => void>();
  let closed = false;
  let files = new Map<string, LocalFileSelection>();
  let config: PaseoConfigRaw = {};
  let configRevision: PaseoConfigRevision | null = null;
  let state: LocalFilesFormState = {
    phase: "empty",
    sourceLabel: null,
    rows: [],
    includeInWorktrees: true,
    includedPaths: [],
    selectedCount: 0,
    selectedBytes: 0,
    canSubmit: false,
    limitExceeded: false,
    configNeedsRefresh: false,
    error: null,
  };
  function busy() {
    return state.phase === "loading" || state.phase === "importing";
  }
  function publish(patch: Partial<LocalFilesFormState>) {
    if (closed) return;
    const next = { ...state, ...patch };
    const selected = next.rows.filter((row) => row.selected && row.status !== "imported");
    const selectedBytes = selected.reduce((sum, row) => sum + row.size, 0);
    const includedPaths = [
      ...new Set([
        ...(config.worktree?.localFiles ?? []),
        ...next.rows.filter((row) => row.selected).map((row) => row.path),
      ]),
    ];
    const hasImported = next.rows.some((row) => row.status === "imported");
    const withinLimits =
      selectedBytes <= LOCAL_FILES_MAX_BYTES &&
      (!next.includeInWorktrees || includedPaths.length <= LOCAL_FILES_MAX_COUNT);
    state = {
      ...next,
      limitExceeded: !withinLimits,
      includedPaths,
      selectedCount: selected.length,
      selectedBytes,
      canSubmit:
        next.phase === "review" &&
        (selected.length > 0 || hasImported) &&
        withinLimits &&
        !next.configNeedsRefresh,
    };
    listeners.forEach((listener) => listener());
  }

  async function loadConfig() {
    const current = await target.client.readProjectConfig(target.root);
    if (!current.ok) throw new Error("invalid_config");
    config = current.config ?? {};
    configRevision = current.revision;
  }

  async function prepare(selections: LocalFileSelection[], sourceLabel: string) {
    if (closed) return;
    if (
      selections.length > LOCAL_FILES_MAX_COUNT ||
      new Set(selections.map((file) => file.path.toLowerCase())).size !== selections.length
    ) {
      files.clear();
      publish({ phase: "empty", rows: [], error: "selection_invalid" });
      return;
    }
    const [inspection] = await Promise.all([
      target.client.inspectProjectLocalFiles({
        projectId: target.projectId,
        paths: selections.map((file) => file.path),
      }),
      loadConfig(),
    ]);
    if (inspection.error) throw new Error(inspection.error);
    if (closed) return;
    files = new Map(selections.map((file) => [file.path, file]));
    const rows: ImportRow[] = selections.map((file) => {
      const destination = inspection.files.find((entry) => entry.path === file.path);
      if (!destination) throw new Error("unavailable");
      let status: ImportRow["status"] = "ready";
      const available =
        file.status === "ready" &&
        (destination.status === "ready" || destination.status === "missing");
      if (!available) status = "unavailable";
      if (file.size > LOCAL_FILE_MAX_BYTES || file.status === "too_large") status = "too_large";
      return {
        path: file.path,
        size: file.size,
        sourceStatus: file.status,
        destination,
        status,
        selected: false,
        error: null,
      };
    });
    publish({
      phase: "review",
      sourceLabel,
      rows: preselectLocalFiles(rows),
      configNeedsRefresh: false,
      error: null,
    });
  }

  async function chooseDevice(pick: () => Promise<LocalFileSelection[] | null>, label: string) {
    if (busy() || closed) return;
    const previous = state;
    publish({ phase: "loading", error: null });
    try {
      const picked = await pick();
      if (picked === null) {
        publish(previous);
        return;
      }
      await prepare(picked, label);
    } catch {
      files.clear();
      publish({ phase: "empty", rows: [], error: "load_failed" });
    }
  }

  async function chooseHost(source: LocalFilesTarget, paths?: string[]) {
    if (busy() || closed) return;
    files.clear();
    publish({
      phase: "loading",
      rows: [],
      sourceLabel: source.label + " · " + source.root,
      error: null,
    });
    try {
      const inspection = await source.client.inspectProjectLocalFiles({
        projectId: source.projectId,
        paths,
      });
      if (inspection.error) throw new Error(inspection.error);
      const candidates = inspection.files.filter((file) => paths || file.status !== "missing");
      const selections: LocalFileSelection[] = candidates.map((file) => ({
        path: file.path,
        size: file.size,
        status: file.status,
        read: async () => {
          if (file.revision === null) throw new Error("changed");
          const result = await source.client.readProjectLocalFile({
            projectId: source.projectId,
            path: file.path,
            expectedRevision: file.revision,
          });
          if (result.error) throw new Error(result.error);
          if (result.data === null) throw new Error("unavailable");
          return new Uint8Array(Buffer.from(result.data, "base64"));
        },
      }));
      await prepare(selections, source.label + " · " + source.root);
      if (!selections.length) publish({ error: "no_source_files" });
    } catch {
      publish({ phase: "empty", error: "load_failed" });
    }
  }

  async function refreshConfig() {
    if (busy() || closed) return;
    publish({ phase: "loading" });
    try {
      await loadConfig();
      publish({ phase: "review", configNeedsRefresh: false, error: null });
    } catch {
      publish({ phase: "review", configNeedsRefresh: true, error: "config_failed" });
    }
  }

  async function importRow(row: ImportRow) {
    try {
      const file = files.get(row.path);
      if (!file) throw new Error("missing");
      const bytes = await file.read();
      if (closed) return;
      if (bytes.length !== row.size || bytes.length > LOCAL_FILE_MAX_BYTES)
        throw new Error("changed");
      const result = await target.client.importProjectLocalFile({
        projectId: target.projectId,
        path: row.path,
        expectedRevision: row.destination.revision,
        data: Buffer.from(bytes).toString("base64"),
      });
      if (result.error) throw new Error(result.error);
      files.delete(row.path);
      publish({
        rows: state.rows.map((item) =>
          item.path === row.path ? { ...item, status: "imported", error: null } : item,
        ),
      });
    } catch (error) {
      publish({
        rows: state.rows.map((item) =>
          item.path === row.path
            ? { ...item, status: "failed", error: toImportError(error) }
            : item,
        ),
      });
    }
  }

  async function submit() {
    if (!state.canSubmit || closed) return;
    publish({ phase: "importing", error: null });
    for (const row of state.rows) {
      if (closed) return;
      if (row.selected && row.status !== "imported") await importRow(row);
    }
    if (closed) return;
    if (state.rows.some((row) => row.selected && row.status === "failed")) {
      publish({ phase: "review", error: "partial_failure" });
      return;
    }
    if (state.includeInWorktrees) {
      const result = await target.client
        .writeProjectConfig({
          repoRoot: target.root,
          config: { ...config, worktree: { ...config.worktree, localFiles: state.includedPaths } },
          expectedRevision: configRevision,
        })
        .catch(() => null);
      if (closed) return;
      if (!result?.ok) {
        publish({ phase: "review", configNeedsRefresh: true, error: "config_failed" });
        return;
      }
    }
    files.clear();
    publish({ phase: "complete" });
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    chooseDevice,
    chooseHost,
    refreshConfig,
    submit,
    setSelected(path: string, selected: boolean) {
      if (state.phase !== "review") return;
      publish({
        rows: state.rows.map((row) =>
          row.path === path && (row.status === "ready" || row.status === "failed")
            ? { ...row, selected }
            : row,
        ),
      });
    },
    setIncludeInWorktrees(value: boolean) {
      if (state.phase !== "review") return;
      publish({ includeInWorktrees: value, configNeedsRefresh: value && state.configNeedsRefresh });
    },
    close() {
      closed = true;
      files.clear();
      listeners.clear();
    },
  };
}
