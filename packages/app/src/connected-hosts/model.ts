import type {
  PaseoApi,
  HostSummary,
  HostUpdate,
  HostDirectory,
  OwnedSubscription,
} from "@getpaseo/client";

export interface Editor {
  key: number;
  host: HostSummary | null;
  connection: string;
  label: string;
  metadata: string;
  replaceIdentity: boolean;
}
type Load =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; directory: HostDirectory };
interface State {
  load: Load;
  editor: Editor | null;
  pending: string | null;
  error: string | null;
}

/** Owns fetch/observation, form sequencing and mutation state outside React. */
export class ConnectedHostsModel {
  private state: State = { load: { status: "loading" }, editor: null, pending: null, error: null };
  private readonly listeners = new Set<() => void>();
  private observation?: OwnedSubscription<HostDirectory>;
  private generation = 0;
  private editorKey = 0;
  private connected = false;
  setConnected = (connected: boolean) => {
    this.connected = connected;
    if (connected && !this.observation) this.start();
    else if (!connected)
      this.publish({
        load: {
          status: "error",
          error:
            "Connection to this daemon was lost. Reconnect to continue; your edits are retained.",
        },
      });
  };
  constructor(private readonly api: PaseoApi) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  start = () => {
    if (!this.connected) {
      this.publish({
        load: { status: "error", error: "Connect to this daemon to load its hosts." },
      });
      return;
    }
    const generation = ++this.generation;
    void this.observation?.release();
    this.publish({ load: { status: "loading" } });
    try {
      const observation = this.api.hosts.observe();
      this.observation = observation;
      observation.subscribe({
        snapshot: (directory) => {
          if (generation === this.generation)
            this.publish({ load: { status: "loaded", directory } });
        },
        update: (message) => {
          if (generation === this.generation && message.type === "hosts.changed")
            this.publish({ load: { status: "loaded", directory: message.payload.directory } });
        },
        error: (error) => {
          if (generation === this.generation)
            this.publish({ load: { status: "error", error: describe(error) } });
        },
      });
      void observation.ready.catch((error) => {
        if (generation === this.generation)
          this.publish({ load: { status: "error", error: describe(error) } });
      });
    } catch (error) {
      this.publish({ load: { status: "error", error: describe(error) } });
    }
  };
  close = () => {
    this.generation++;
    void this.observation?.release();
    void this.api.dispose();
    this.listeners.clear();
  };
  edit = (host: HostSummary | null) => {
    if (this.state.pending) return;
    this.publish({
      error: null,
      editor: {
        key: ++this.editorKey,
        host,
        connection: "",
        label: host?.label ?? "",
        metadata: JSON.stringify(host?.metadata ?? {}, null, 2),
        replaceIdentity: false,
      },
    });
  };
  add = () => this.edit(null);
  setLabel = (label: string) => this.set({ label });
  setConnection = (connection: string) => this.set({ connection });
  setMetadata = (metadata: string) => this.set({ metadata });
  setReplaceIdentity = (replaceIdentity: boolean) => this.set({ replaceIdentity });
  set = (patch: Partial<Omit<Editor, "host" | "key">>) => {
    if (this.state.editor) this.publish({ editor: { ...this.state.editor, ...patch } });
  };
  cancel = () => {
    if (!this.state.pending) this.publish({ editor: null, error: null });
  };
  dismissError = () => this.publish({ error: null });
  private async mutate(id: string, operation: () => Promise<unknown>): Promise<void> {
    if (this.state.pending) return;
    this.publish({ pending: id, error: null });
    try {
      await operation();
      this.publish({
        load: { status: "loaded", directory: await this.api.hosts.list() },
        editor: null,
      });
    } catch (error) {
      this.publish({ error: describe(error) });
    } finally {
      this.publish({ pending: null });
    }
  }
  save = () =>
    this.mutate("save", async () => {
      const editor = this.state.editor;
      if (!editor) return;
      let metadata: Record<string, string>;
      try {
        const value: unknown = JSON.parse(editor.metadata);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.values(value).some((entry) => typeof entry !== "string")
        )
          throw new Error("invalid");
        metadata = value as Record<string, string>;
      } catch {
        throw new Error("Metadata must be a JSON object with string values.");
      }
      if (editor.host) {
        const patch: HostUpdate = {
          label: editor.label.trim() || null,
          replaceIdentity: editor.replaceIdentity,
        };
        if (JSON.stringify(metadata) !== JSON.stringify(editor.host.metadata))
          patch.metadata = metadata;
        if (editor.connection.trim()) {
          patch.connection = editor.connection.trim();
        }
        await this.api.hosts.update(editor.host.registrationId, patch);
      } else
        await this.api.hosts.add({
          connection: editor.connection.trim(),
          label: editor.label.trim() || undefined,
          metadata,
        });
    });
  setEnabled = (host: HostSummary) =>
    this.mutate(host.registrationId, () =>
      this.api.hosts.update(host.registrationId, { enabled: !host.enabled }),
    );
  remove = (host: HostSummary) =>
    this.mutate(host.registrationId, () => this.api.hosts.remove(host.registrationId));
}
function describe(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "userMessage" in error &&
    typeof error.userMessage === "string"
  )
    return error.userMessage;
  return error instanceof Error ? error.message : "Host operation failed. Retry when connected.";
}
