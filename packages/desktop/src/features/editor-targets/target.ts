export type EditorTargetKind = "editor" | "file-manager";

/**
 * How an editor is expected to reach another machine. Editors disagree on the syntax —
 * VS Code wants a `vscode-remote://ssh-remote+<host>` authority, Zed wants an `ssh://` URL —
 * so what gets stored is the destination itself and each target renders its own form.
 * `wsl` and `dev-container` belong here as further kinds when they are supported.
 */
export type RemoteDestinationKind = "ssh";

export interface RemoteDestination {
  kind: "ssh";
  /** An SSH destination: `[user@]host[:port]`, normally an alias from `~/.ssh/config`. */
  host: string;
}

export type EditorTargetIcon =
  | { kind: "image"; dataUrl: string }
  | { kind: "symbol"; name: "folder" | "terminal" };

export interface EditorTargetDescriptor {
  id: string;
  label: string;
  kind: EditorTargetKind;
  icon: EditorTargetIcon;
  remoteDestinationKinds: readonly RemoteDestinationKind[];
}

/** What a target reports about itself; the registry stamps on the static capabilities. */
export type EditorTargetDescription = Omit<EditorTargetDescriptor, "remoteDestinationKinds">;

export interface EditorTargetLaunchInput {
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
  /**
   * When set, `workspacePath` and `filePath` name paths on that remote machine, not on
   * this one, and the target renders them in whatever remote form it speaks.
   */
  remoteDestination?: RemoteDestination;
}

export interface EditorTargetRuntime {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;

  pathExists(path: string): boolean;
  isAbsolutePath(path: string): boolean;
  resolveCommand(commands: readonly string[]): string | null;
  spawnDetached(input: { command: string; args: readonly string[] }): Promise<void>;
  openPath(path: string): Promise<void>;
  revealPath(path: string): void;
  loadIcon(fileName: string): Promise<EditorTargetIcon>;
  hasMacApplication(applicationName: string): boolean;
  openMacApplication(input: { applicationName: string; paths: readonly string[] }): Promise<void>;
}

export interface EditorTarget {
  readonly id: string;
  /** Destination kinds `launch` can render. The registry refuses the rest. */
  readonly remoteDestinationKinds: readonly RemoteDestinationKind[];

  describe(runtime: EditorTargetRuntime): Promise<EditorTargetDescription>;
  isInstalled(runtime: EditorTargetRuntime): Promise<boolean>;
  launch(input: EditorTargetLaunchInput, runtime: EditorTargetRuntime): Promise<void>;
}
