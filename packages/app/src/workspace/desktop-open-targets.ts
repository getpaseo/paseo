import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getIsElectron } from "@/constants/platform";
import { getDesktopHost, type DesktopEditorBridge } from "@/desktop/host";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";

export type DesktopOpenTargetKind = "editor" | "file-manager";
export type DesktopOpenTargetIcon =
  | { kind: "image"; dataUrl: string }
  | { kind: "symbol"; name: "folder" | "terminal" };

export interface DesktopOpenTarget {
  id: string;
  label: string;
  kind: DesktopOpenTargetKind;
  icon: DesktopOpenTargetIcon;
}

export interface OpenDesktopTargetInput {
  editorId: string;
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
}

interface AvailableDesktopEditorBridge {
  listTargets: NonNullable<DesktopEditorBridge["listTargets"]>;
  openTarget: NonNullable<DesktopEditorBridge["openTarget"]>;
}

interface SelectDesktopOpenTargetsInput {
  canListTargets: boolean;
  targets: DesktopOpenTarget[] | undefined;
}

export function selectDesktopOpenTargets({
  canListTargets,
  targets,
}: SelectDesktopOpenTargetsInput): DesktopOpenTarget[] {
  if (!canListTargets) {
    return [];
  }
  return targets ?? [];
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

export function useDesktopOpenTargets(input: { isLocalExecution: boolean }) {
  const hasBridge = hasDesktopOpenTargetsBridge();
  const canListTargets = hasBridge && input.isLocalExecution;
  const query = useQuery({
    queryKey: ["desktop-open-targets"],
    enabled: canListTargets,
    staleTime: 60_000,
    retry: false,
    queryFn: listDesktopOpenTargets,
  });
  const targets = selectDesktopOpenTargets({
    canListTargets,
    targets: query.data,
  });

  return {
    targets,
    isAvailable: canListTargets,
  };
}

/**
 * The file-manager open target for revealing folders in the OS file manager, or null when
 * unavailable — outside the Electron desktop wrapper or connected to a remote daemon,
 * where local file paths would be meaningless.
 */
export function useFileManagerOpenTarget(serverId: string | null): DesktopOpenTarget | null {
  const isLocalDaemon = useIsLocalDaemon(serverId ?? "");
  const isElectron = getIsElectron();
  const { targets } = useDesktopOpenTargets({
    isLocalExecution: isElectron && isLocalDaemon,
  });
  return useMemo(
    () => targets.find((candidate) => candidate.kind === "file-manager") ?? null,
    [targets],
  );
}
