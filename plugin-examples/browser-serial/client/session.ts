import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  MAX_CHUNK_BYTES,
  type createBridge,
  type pollBridge,
  type renewBridge,
  type writeBridge,
  type closeBridge,
  type releaseBridge,
} from "../shared/bridge";

export interface SerialReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}
export interface SerialWriter {
  write(data: Uint8Array): Promise<void>;
  abort(): Promise<void>;
  releaseLock(): void;
}
export interface SerialPort {
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  open(options: { baudRate: number; bufferSize: number }): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  readable: { getReader(): SerialReader } | null;
  writable: { getWriter(): SerialWriter } | null;
}
export interface SerialBrowser {
  unavailable: string | null;
  requestPort(): Promise<SerialPort>;
  encode(data: Uint8Array): string;
  decode(data: string): Uint8Array;
  onLeave(callback: () => void): () => void;
}
export interface BridgeRpc {
  create(input: RpcInput<typeof createBridge>): Promise<RpcOutput<typeof createBridge>>;
  poll(input: RpcInput<typeof pollBridge>): Promise<RpcOutput<typeof pollBridge>>;
  renew(input: RpcInput<typeof renewBridge>): Promise<unknown>;
  write(input: RpcInput<typeof writeBridge>): Promise<unknown>;
  close(input: RpcInput<typeof closeBridge>): Promise<unknown>;
  release(input: RpcInput<typeof releaseBridge>): Promise<unknown>;
}
export interface SerialState {
  baudRate: number;
  phase: "idle" | "connecting" | "active" | "stopping" | "forgetting";
  label: string;
  endpoint: string | null;
  connected: boolean;
  error: string | null;
  canForget: boolean;
  releasing: boolean;
  releaseError: string | null;
}
interface Run {
  stopped: boolean;
  initialized: Promise<void>;
  cleanup?: Promise<void>;
  port?: SerialPort;
  opened?: boolean;
  token?: string;
  reader?: SerialReader;
  writer?: SerialWriter;
  reading?: Promise<void>;
  polling?: Promise<void>;
  renewing?: Promise<void>;
  cancelHeartbeat?: () => void;
}

function scheduleHeartbeat(callback: () => void): () => void {
  const timer = setInterval(callback, 5_000);
  return () => clearInterval(timer);
}

export class SerialSession {
  private state: SerialState = {
    baudRate: 115200,
    phase: "idle",
    label: "No device selected",
    endpoint: null,
    connected: false,
    error: null,
    canForget: false,
    releasing: false,
    releaseError: null,
  };
  private listeners = new Set<() => void>();
  private run?: Run;
  private lastPort?: SerialPort;

  constructor(
    private browser: SerialBrowser,
    private rpc: BridgeRpc,
    private heartbeat = scheduleHeartbeat,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  mount() {
    const remove = this.browser.onLeave(() => {
      void this.stop();
    });
    return () => {
      remove();
      return this.stop();
    };
  }
  private update(patch: Partial<SerialState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setBaudRate(baudRate: number) {
    if (this.state.phase === "idle") this.update({ baudRate });
  }
  connect(baudRate: number): void {
    if (this.run || this.state.phase !== "idle" || this.browser.unavailable) return;
    const run: Run = { stopped: false, initialized: Promise.resolve() };
    this.run = run;
    this.update({ phase: "connecting", baudRate, error: null, canForget: false });
    // Preserve the button's user activation: requestPort must precede any await.
    let selection: Promise<SerialPort>;
    try {
      selection = this.browser.requestPort();
    } catch (error) {
      selection = Promise.reject(error);
    }
    run.initialized = this.initialize(run, selection, baudRate);
    void run.initialized.catch((error: unknown) => {
      void this.stop(error);
    });
  }
  private async initialize(run: Run, selection: Promise<SerialPort>, baudRate: number) {
    run.port = await selection;
    this.lastPort = run.port;
    if (run.stopped) return;
    const info = run.port.getInfo();
    if (info.usbVendorId === undefined) throw new Error("Choose a USB serial device.");
    this.update({
      label: `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`,
    });
    await run.port.open({ baudRate, bufferSize: MAX_CHUNK_BYTES });
    run.opened = true;
    if (run.stopped) return;
    if (!run.port.readable || !run.port.writable)
      throw new Error("The device has no serial streams.");
    const bridge = await this.rpc.create({});
    run.token = bridge.token;
    if (run.stopped) return;
    run.reader = run.port.readable.getReader();
    run.writer = run.port.writable.getWriter();
    this.update({ phase: "active", endpoint: `127.0.0.1:${bridge.port}`, connected: false });
    // Serial writes can take longer than the host lease at low baud rates.
    // Renew independently without reading ahead or queuing more device writes.
    run.cancelHeartbeat = this.heartbeat(() => {
      if (run.stopped || run.renewing) return;
      run.renewing = this.rpc.renew({ token: run.token! }).then(
        () => {
          run.renewing = undefined;
          return undefined;
        },
        (error: unknown) => {
          void this.stop(error);
          return undefined;
        },
      );
    });
    run.reading = this.read(run).catch((error: unknown) => {
      void this.stop(error);
    });
    run.polling = this.poll(run).catch((error: unknown) => {
      void this.stop(error);
    });
  }
  private async read(run: Run) {
    while (!run.stopped) {
      const { done, value } = await run.reader!.read();
      if (run.stopped) return;
      if (done) throw new Error("The serial device disconnected.");
      if (!value) continue;
      for (let offset = 0; offset < value.length && !run.stopped; offset += MAX_CHUNK_BYTES) {
        await this.rpc.write({
          token: run.token!,
          data: this.browser.encode(value.subarray(offset, offset + MAX_CHUNK_BYTES)),
        });
      }
    }
  }
  private async poll(run: Run) {
    while (!run.stopped) {
      const result = await this.rpc.poll({ token: run.token! });
      if (run.stopped) return;
      if (result.closed)
        throw new Error("The host bridge closed. Choose the device again to reconnect.");
      if (result.connected !== this.state.connected) this.update({ connected: result.connected });
      if (result.data) await run.writer!.write(this.browser.decode(result.data));
    }
  }
  async release() {
    const run = this.run;
    if (!run || this.state.phase !== "active" || !this.state.connected || this.state.releasing)
      return;
    this.update({ releasing: true, releaseError: null });
    try {
      await this.rpc.release({ token: run.token! });
      if (this.run === run && !run.stopped) this.update({ connected: false });
    } catch (error) {
      if (this.run === run && !run.stopped)
        this.update({ releaseError: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.run === run && !run.stopped) this.update({ releasing: false });
    }
  }
  stop(error?: unknown): Promise<void> {
    const run = this.run;
    if (!run) return Promise.resolve();
    if (run.cleanup) return run.cleanup;
    run.stopped = true;
    run.cancelHeartbeat?.();
    let message = error ? String(error) : null;
    if (error instanceof Error) message = error.message;
    this.update({ phase: "stopping", error: message });
    run.cleanup = this.cleanup(run);
    return run.cleanup;
  }
  private async cleanup(run: Run) {
    await run.initialized.catch(() => {});
    // Free the local device even if the host is offline and its RPC must time out.
    const remote = run.token
      ? this.rpc.close({ token: run.token }).then(
          () => null,
          (error: unknown) => error,
        )
      : Promise.resolve(null);
    const streams = await Promise.allSettled([run.reader?.cancel(), run.writer?.abort()]);
    run.reader?.releaseLock();
    run.writer?.releaseLock();
    let closeError: unknown;
    if (run.opened) {
      try {
        await run.port!.close();
      } catch (error) {
        closeError = error;
      }
    }
    const remoteError = await remote;
    await Promise.allSettled([run.reading, run.polling]);
    this.run = undefined;
    const failure =
      closeError ?? remoteError ?? streams.find((result) => result.status === "rejected")?.reason;
    this.update({
      phase: "idle",
      endpoint: null,
      connected: false,
      releasing: false,
      releaseError: null,
      canForget: Boolean(this.lastPort?.forget),
      error:
        this.state.error ??
        (failure
          ? "Cleanup was incomplete. The host lease will expire; check browser device permissions."
          : null),
    });
  }
  async forget() {
    if (this.run || this.state.phase !== "idle" || !this.lastPort?.forget) return;
    this.update({ phase: "forgetting", error: null });
    try {
      await this.lastPort.forget();
      this.lastPort = undefined;
      this.update({ label: "No device selected", canForget: false, error: null });
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.update({ phase: "idle" });
    }
  }
}
