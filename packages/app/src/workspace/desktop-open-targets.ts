import { useQuery } from "@tanstack/react-query";
import { getDesktopHost, type DesktopEditorBridge } from "@/desktop/host";

export type DesktopOpenTargetKind = "editor" | "file-manager";
export type DesktopOpenTargetIcon =
  | { kind: "image"; dataUrl: string }
  | { kind: "symbol"; name: "folder" | "terminal" };

/**
 * How an editor reaches another machine. Editors disagree on the syntax — VS Code wants a
 * `vscode-remote://ssh-remote+<host>` authority, Zed wants an `ssh://` URL — so the client
 * stores the destination and each target renders its own form. `wsl` and `dev-container`
 * belong here as further kinds when they are supported.
 */
export type RemoteDestinationKind = "ssh";

export interface RemoteDestination {
  kind: "ssh";
  /** An SSH destination: `[user@]host[:port]`, normally an alias from `~/.ssh/config`. */
  host: string;
}

export interface DesktopOpenTarget {
  id: string;
  label: string;
  kind: DesktopOpenTargetKind;
  icon: DesktopOpenTargetIcon;
  remoteDestinationKinds: readonly RemoteDestinationKind[];
}

export interface OpenDesktopTargetInput {
  editorId: string;
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
  remoteDestination?: RemoteDestination;
}

/**
 * Where the paths a desktop target is asked to open actually live. `remote` means the
 * daemon runs on another machine the editor can reach; `remote-unconfigured` means it runs
 * elsewhere and no destination is set yet, so nothing can be launched but the feature can
 * still be offered as a setup step.
 */
export type DesktopOpenExecution =
  | { kind: "local" }
  | { kind: "remote"; destination: RemoteDestination }
  | { kind: "remote-unconfigured" };

export const LOCAL_DESKTOP_OPEN_EXECUTION: DesktopOpenExecution = { kind: "local" };
export const REMOTE_UNCONFIGURED_DESKTOP_OPEN_EXECUTION: DesktopOpenExecution = {
  kind: "remote-unconfigured",
};

interface AvailableDesktopEditorBridge {
  listTargets: NonNullable<DesktopEditorBridge["listTargets"]>;
  openTarget: NonNullable<DesktopEditorBridge["openTarget"]>;
}

interface SelectDesktopOpenTargetsInput {
  execution: DesktopOpenExecution | null;
  targets: DesktopOpenTarget[] | undefined;
}

export function selectDesktopOpenTargets({
  execution,
  targets,
}: SelectDesktopOpenTargetsInput): DesktopOpenTarget[] {
  if (!execution) {
    return [];
  }
  const available = targets ?? [];
  if (execution.kind === "local") {
    return available;
  }
  // An unconfigured host has no destination yet, so any remote-capable target counts: the
  // question there is only whether a setup entry could ever lead somewhere.
  if (execution.kind === "remote-unconfigured") {
    return available.filter((target) => target.remoteDestinationKinds.length > 0);
  }
  const { kind } = execution.destination;
  return available.filter((target) => target.remoteDestinationKinds.includes(kind));
}

function getDesktopEditorBridge(): AvailableDesktopEditorBridge | null {
  const bridge = getDesktopHost()?.editor;
  if (!bridge?.listTargets || !bridge.openTarget) {
    return null;
  }
  return {
    listTargets: bridge.listTargets,
    openTarget: bridge.openTarget,
  };
}

export function hasDesktopOpenTargetsBridge(): boolean {
  return getDesktopEditorBridge() !== null;
}

export async function listDesktopOpenTargets(): Promise<DesktopOpenTarget[]> {
  const bridge = getDesktopEditorBridge();
  if (!bridge) {
    return [];
  }
  return await bridge.listTargets();
}

export async function openDesktopTarget(input: OpenDesktopTargetInput): Promise<void> {
  const bridge = getDesktopEditorBridge();
  if (!bridge) {
    throw new Error("Desktop editor bridge is unavailable");
  }
  await bridge.openTarget(input);
}

export function useDesktopOpenTargets(input: { execution: DesktopOpenExecution | null }) {
  const hasBridge = hasDesktopOpenTargetsBridge();
  const execution = hasBridge ? input.execution : null;
  const query = useQuery({
    queryKey: ["desktop-open-targets"],
    enabled: execution !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: listDesktopOpenTargets,
  });
  const targets = selectDesktopOpenTargets({
    execution,
    targets: query.data,
  });

  return {
    targets,
    isAvailable: execution !== null,
  };
}
