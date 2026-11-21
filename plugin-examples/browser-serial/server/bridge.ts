import { randomBytes } from "node:crypto";
import net from "node:net";
import { MAX_CHUNK_BYTES } from "../shared/bridge";

// Raw binary bridge: the browser owns Web Serial; one host tool connects over
// TCP to an ephemeral listener bound ONLY to 127.0.0.1.
//
// Security: the listener has no authentication. Any trusted local process that
// finds the ephemeral port can take the single TCP slot (or be rejected once
// the agent holds it) and exchange raw bytes with the browser side. The RPC
// token authorizes browser operations only; it does not authenticate the TCP
// peer. Treat the port as visible to the local machine, never as a secret.

const LEASE_MS = 20_000;
const POLL_MS = 5_000;
const MAX_BUFFERED_BYTES = 262_144; // per direction
const MAX_ENCODED_BYTES = 43_692; // ceil(32768 / 3) * 4
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface BridgeClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const systemClock: BridgeClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface BridgeOptions {
  leaseMs?: number;
  pollTimeoutMs?: number;
  maxBufferedBytes?: number;
  clock?: BridgeClock;
  // Test seam for deterministic backpressure (e.g. a low highWaterMark).
  // Production always uses the default loopback listener.
  createServer?: () => net.Server;
}

export interface PollResult {
  data: string;
  connected: boolean;
  closed: boolean;
}

interface Session {
  token: string;
  listener: net.Server;
  port: number;
  tcp: net.Socket | null;
  preconnect: Buffer[];
  preconnectLength: number;
  inbound: Buffer[];
  inboundLength: number;
  pending: { resolve: (result: PollResult) => void; timer: unknown } | null;
  lease: unknown;
  closed: boolean;
}

function unrefTimer(timer: unknown): void {
  const ref = timer as { unref?: () => void } | null;
  if (typeof ref?.unref === "function") ref.unref();
}

function decodeChunk(data: string): Buffer {
  if (data.length > MAX_ENCODED_BYTES || !BASE64_PATTERN.test(data)) {
    throw new Error("Invalid base64 chunk.");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data || bytes.length > MAX_CHUNK_BYTES) {
    throw new Error("Invalid base64 chunk.");
  }
  return bytes;
}

export class SerialBridge {
  private session: Session | null = null;
  private lastClosedToken: string | null = null;
  private disposed = false;
  private readonly clock: BridgeClock;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly maxBuffered: number;
  private readonly createServer: () => net.Server;

  constructor(options: BridgeOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.pollMs = options.pollTimeoutMs ?? POLL_MS;
    this.maxBuffered = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.createServer = options.createServer ?? (() => net.createServer());
  }

  async create(): Promise<{ token: string; port: number }> {
    if (this.disposed) throw new Error("Serial bridge is disposed.");
    if (this.session) throw new Error("A serial bridge is already active.");
    const token = randomBytes(32).toString("hex");
    const listener = this.createServer();
    const session: Session = {
      token,
      listener,
      port: 0,
      tcp: null,
      preconnect: [],
      preconnectLength: 0,
      inbound: [],
      inboundLength: 0,
      pending: null,
      lease: null,
      closed: false,
    };
    listener.on("connection", (socket) => this.onConnection(session, socket));
    listener.on("error", () => this.closeSession(session));
    this.session = session;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        listener.once("error", onError);
        listener.listen(0, "127.0.0.1", () => {
          listener.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      this.closeSession(session);
      throw error;
    }
    const address = listener.address();
    if (typeof address !== "object" || address === null) {
      this.closeSession(session);
      throw new Error("Serial bridge listener has no address.");
    }
    session.port = address.port;
    this.resetLease(session);
    return { token, port: session.port };
  }

  async poll(token: string): Promise<PollResult> {
    const session = this.session;
    if (!session || session.token !== token) {
      // Closed bridges report closed once; anything else is not ours.
      if (token === this.lastClosedToken) return { data: "", connected: false, closed: true };
      throw new Error("Unknown bridge token.");
    }
    if (session.pending) throw new Error("A bridge poll is already pending.");
    this.resetLease(session); // accepted polls renew the lease; renew RPC does too
    if (session.inboundLength > 0) {
      return { data: this.takeChunk(session), connected: session.tcp !== null, closed: false };
    }
    return new Promise<PollResult>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        if (session.pending?.timer === timer) {
          session.pending = null;
          resolve({ data: "", connected: session.tcp !== null, closed: false });
        }
      }, this.pollMs);
      unrefTimer(timer);
      session.pending = { resolve, timer };
    });
  }

  async renew(token: string): Promise<{}> {
    const session = this.session;
    if (!session || session.token !== token) throw new Error("Unknown bridge token.");
    this.resetLease(session);
    return {};
  }

  async write(token: string, data: string): Promise<{}> {
    const session = this.session;
    if (!session || session.token !== token) throw new Error("Unknown bridge token.");
    const chunk = decodeChunk(data);
    if (chunk.length === 0) return {};
    // Bytes go to whoever owns the slot at send time. A concurrent slot
    // release may truncate them at the boundary without failing this write;
    // they are never re-sent to the next owner (no duplicates).
    const tcp = session.tcp;
    if (tcp && !tcp.destroyed) {
      if (tcp.writableLength + chunk.length > this.maxBuffered) {
        this.closeSession(session);
        throw new Error("Bridge write buffer overflow; bridge closed.");
      }
      if (!tcp.write(chunk)) await this.waitForDrain(session, tcp);
      return {};
    }
    // No host connection yet: buffer startup banners, bounded; never drop.
    if (session.preconnectLength + chunk.length > this.maxBuffered) {
      this.closeSession(session);
      throw new Error("Bridge pre-connect buffer overflow; bridge closed.");
    }
    session.preconnect.push(chunk);
    session.preconnectLength += chunk.length;
    return {};
  }

  async close(token: string): Promise<{}> {
    const session = this.session;
    if (session && session.token === token) this.closeSession(session);
    else if (token !== this.lastClosedToken) throw new Error("Unknown bridge token.");
    return {};
  }

  // Frees the current TCP owner so another host tool can connect to the same
  // endpoint. The listener, port, token, browser lease, and bounded queues
  // survive. Authorization matches close(): unknown tokens fail, the most
  // recently closed token succeeds without touching any live bridge.
  async release(token: string): Promise<{}> {
    const session = this.session;
    if (session && session.token === token) {
      this.releaseSlot(session);
      return {};
    }
    if (token !== this.lastClosedToken) throw new Error("Unknown bridge token.");
    return {};
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.session) this.closeSession(this.session);
  }

  private onConnection(session: Session, socket: net.Socket): void {
    if (this.session !== session || session.closed || (session.tcp && !session.tcp.destroyed)) {
      socket.destroy(); // one TCP client at a time; reject the rest
      return;
    }
    session.tcp = socket;
    if (session.preconnectLength > 0) {
      const flushed = Buffer.concat(session.preconnect, session.preconnectLength);
      session.preconnect = [];
      session.preconnectLength = 0;
      socket.write(flushed);
    }
    socket.on("data", (data: Buffer) => {
      // A superseded socket must not queue bytes or disturb the new owner.
      if (this.session !== session || session.closed || session.tcp !== socket) return;
      session.inbound.push(data);
      session.inboundLength += data.length;
      if (session.inboundLength > this.maxBuffered) {
        this.closeSession(session); // overflow closes; never silently drops
        return;
      }
      if (session.pending) {
        this.resolvePending(session, {
          data: this.takeChunk(session),
          connected: true,
          closed: false,
        });
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.session !== session || session.closed || session.tcp !== socket) return;
      this.releaseSlot(session); // host disconnect frees only this client's slot
    });
    if (session.pending) {
      this.resolvePending(session, {
        data: this.takeChunk(session),
        connected: true,
        closed: false,
      });
    }
  }

  private takeChunk(session: Session): string {
    if (session.inboundLength === 0) return "";
    const all = Buffer.concat(session.inbound, session.inboundLength);
    const head = all.subarray(0, MAX_CHUNK_BYTES);
    const rest = all.subarray(MAX_CHUNK_BYTES);
    session.inbound = rest.length > 0 ? [Buffer.from(rest)] : [];
    session.inboundLength = rest.length;
    return head.toString("base64");
  }

  private resolvePending(session: Session, result: PollResult): void {
    const pending = session.pending;
    session.pending = null;
    if (pending) {
      this.clock.clearTimeout(pending.timer);
      pending.resolve(result);
    }
  }

  private resetLease(session: Session): void {
    if (session.lease !== null) this.clock.clearTimeout(session.lease);
    const lease = this.clock.setTimeout(() => this.closeSession(session), this.leaseMs);
    unrefTimer(lease);
    session.lease = lease;
  }

  private waitForDrain(session: Session, socket: net.Socket): Promise<void> {
    return new Promise<void>((resolve) => {
      const cleanup = () => {
        socket.off("drain", onDrain);
        socket.off("close", onReleased);
        socket.off("error", onReleased);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      // The owner may disconnect or be released while a device->host write
      // awaits drain. Resolve instead of rejecting: rejecting here would kill
      // the browser session on a routine handoff. In-flight bytes addressed
      // to the departed owner are truncated at the slot boundary.
      const onReleased = () => {
        cleanup();
        resolve();
      };
      socket.once("drain", onDrain);
      socket.once("close", onReleased);
      socket.once("error", onReleased);
      if (session.closed || socket.destroyed || session.tcp !== socket) onReleased();
    });
  }

  // Frees the current TCP owner without ending the bridge. Listener, port,
  // token, browser lease, and bounded queues survive, so the next client
  // connects to the SAME endpoint. Queues are client-independent once
  // accepted: received tool->device bytes stay queued for the browser, and
  // device->host bytes written during the gap buffer for the next owner.
  // FIFO order is preserved and nothing is re-sent. There is no transaction
  // isolation: a partial command from the old owner concatenates with the new
  // owner's bytes at the device, and delayed hardware responses cannot be
  // attributed to one owner. Hand over only between complete commands.
  private releaseSlot(session: Session): void {
    const tcp = session.tcp;
    if (!tcp) return; // idempotent: no owner, no state change, polls stay parked
    session.tcp = null;
    tcp.destroy();
    if (session.pending) {
      this.resolvePending(session, {
        data: this.takeChunk(session),
        connected: false,
        closed: false,
      });
    }
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (session.lease !== null) {
      this.clock.clearTimeout(session.lease);
      session.lease = null;
    }
    if (session.pending) {
      this.resolvePending(session, {
        data: this.takeChunk(session),
        connected: false,
        closed: true,
      });
    }
    session.preconnect = [];
    session.preconnectLength = 0;
    session.inbound = [];
    session.inboundLength = 0;
    const tcp = session.tcp;
    session.tcp = null;
    tcp?.destroy();
    session.listener.close(() => undefined);
    if (this.session === session) {
      this.session = null;
      this.lastClosedToken = session.token;
    }
  }
}
