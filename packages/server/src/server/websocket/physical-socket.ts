// Terminal streams begin snapshot catch-up at 4 MiB. The physical socket gets
// another 4 MiB to recover before the daemon enforces the hard memory bound.
export const MAX_PHYSICAL_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
// Current clients ping every 10 seconds. Four delayed cycles fit inside the
// lease without making an abandoned application socket linger for minutes.
export const APPLICATION_SOCKET_LEASE_MS = 45_000;
export const APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS = 10_000;

type Clock = () => number;

export class ApplicationSocketLease<TSocket extends object> {
  private readonly deadlines = new Map<TSocket, number>();

  constructor(private readonly clock: Clock = Date.now) {}

  claim(socket: TSocket): void {
    this.deadlines.set(socket, this.clock() + APPLICATION_SOCKET_LEASE_MS);
  }

  renew(socket: TSocket): void {
    if (this.deadlines.has(socket)) {
      this.claim(socket);
    }
  }

  release(socket: TSocket): void {
    this.deadlines.delete(socket);
  }

  listExpired(): TSocket[] {
    const now = this.clock();
    const expired: TSocket[] = [];
    for (const [socket, deadline] of this.deadlines) {
      if (deadline > now) continue;
      expired.push(socket);
    }
    return expired;
  }

  clear(): void {
    this.deadlines.clear();
  }
}

export function outboundFrameByteLength(data: string | Uint8Array | ArrayBuffer): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  return data.byteLength;
}

interface BoundedPhysicalSocket {
  readyState: number;
  bufferedAmount?: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void;
}

export function physicalSocketHasCapacity(
  socket: Pick<BoundedPhysicalSocket, "bufferedAmount">,
  frameBytes: number,
): boolean {
  if (typeof socket.bufferedAmount !== "number") return true;
  return socket.bufferedAmount + frameBytes <= MAX_PHYSICAL_SOCKET_BUFFERED_BYTES;
}

export function sendBoundedPhysicalFrame(params: {
  socket: BoundedPhysicalSocket;
  frame: string | Uint8Array | ArrayBuffer;
  frameBytes?: number;
  onHighWater: () => void;
}): boolean {
  const { socket, frame, frameBytes = outboundFrameByteLength(frame), onHighWater } = params;
  if (socket.readyState !== 1) return false;
  if (!physicalSocketHasCapacity(socket, frameBytes)) {
    onHighWater();
    return false;
  }
  socket.send(frame);
  return true;
}
