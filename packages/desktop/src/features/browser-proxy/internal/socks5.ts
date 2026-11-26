import type { Duplex } from "node:stream";
import { NetworkTunnelCloseReason } from "@getpaseo/protocol/network-tunnel";

const SOCKS5_VERSION = 0x05;
const SOCKS5_AUTH_NONE = 0x00;
const SOCKS5_AUTH_NO_ACCEPTABLE = 0xff;
const SOCKS5_CMD_CONNECT = 0x01;
const SOCKS5_ATYP_IPV4 = 0x01;
const SOCKS5_ATYP_DOMAIN = 0x03;
const SOCKS5_ATYP_IPV6 = 0x04;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export enum Socks5ReplyCode {
  Succeeded = 0x00,
  GeneralFailure = 0x01,
  ConnectionNotAllowed = 0x02,
  NetworkUnreachable = 0x03,
  HostUnreachable = 0x04,
  ConnectionRefused = 0x05,
  CommandNotSupported = 0x07,
  AddressTypeNotSupported = 0x08,
}

export class Socks5Error extends Error {
  public readonly replyCode: Socks5ReplyCode | null;

  public constructor(message: string, replyCode: Socks5ReplyCode | null = null) {
    super(message);
    this.name = "Socks5Error";
    this.replyCode = replyCode;
  }
}

export interface Socks5ConnectRequest {
  host: string;
  port: number;
  leftover: Buffer;
}

export function socks5ReplyForTunnelCloseReason(reason: NetworkTunnelCloseReason): Socks5ReplyCode {
  switch (reason) {
    case NetworkTunnelCloseReason.ConnectRefused:
      return Socks5ReplyCode.ConnectionRefused;
    case NetworkTunnelCloseReason.PolicyDenied:
      return Socks5ReplyCode.ConnectionNotAllowed;
    case NetworkTunnelCloseReason.HostUnreachable:
      return Socks5ReplyCode.NetworkUnreachable;
    case NetworkTunnelCloseReason.DnsFailed:
    case NetworkTunnelCloseReason.Timeout:
      return Socks5ReplyCode.HostUnreachable;
    default:
      return Socks5ReplyCode.GeneralFailure;
  }
}

export function writeSocks5Reply(socket: Duplex, replyCode: Socks5ReplyCode): void {
  if (socket.destroyed || !socket.writable) {
    return;
  }
  socket.write(Buffer.from([SOCKS5_VERSION, replyCode, 0x00, SOCKS5_ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
}

function formatIpv6Bytes(bytes: Buffer): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(bytes.readUInt16BE(i));
  }
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i += 1) {
    if (groups[i] === 0) {
      if (curStart === -1) {
        curStart = i;
        curLen = 1;
      } else {
        curLen += 1;
      }
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) {
    return groups.map((g) => g.toString(16)).join(":");
  }
  const head = groups
    .slice(0, bestStart)
    .map((g) => g.toString(16))
    .join(":");
  const tail = groups
    .slice(bestStart + bestLen)
    .map((g) => g.toString(16))
    .join(":");
  return `${head}::${tail}`;
}

class BufferedSocketReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private failure: Error | null = null;
  private waiting: {
    need: number;
    resolve: (bytes: Buffer) => void;
    reject: (error: Error) => void;
  } | null = null;

  private readonly onData = (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? buf : Buffer.concat([this.buffer, buf]);
    this.flushWaiter();
  };

  private readonly onEnd = () => {
    this.ended = true;
    this.flushWaiter();
  };

  private readonly onError = (error: Error) => {
    this.failure = error;
    this.flushWaiter();
  };

  private readonly onClose = () => {
    this.ended = true;
    this.flushWaiter();
  };

  public constructor(private readonly socket: Duplex) {
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  public readExact(count: number): Promise<Buffer> {
    if (this.buffer.length >= count) {
      const out = this.buffer.subarray(0, count);
      this.buffer = this.buffer.subarray(count);
      return Promise.resolve(out);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.ended) {
      return Promise.reject(new Socks5Error("SOCKS5 client closed during handshake"));
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.waiting = { need: count, resolve, reject };
    });
  }

  public detach(): Buffer {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    const leftover = this.buffer;
    this.buffer = Buffer.alloc(0);
    return leftover;
  }

  private flushWaiter(): void {
    const waiter = this.waiting;
    if (!waiter) return;
    if (this.buffer.length >= waiter.need) {
      this.waiting = null;
      const out = this.buffer.subarray(0, waiter.need);
      this.buffer = this.buffer.subarray(waiter.need);
      waiter.resolve(out);
      return;
    }
    if (this.failure) {
      this.waiting = null;
      waiter.reject(this.failure);
      return;
    }
    if (this.ended) {
      this.waiting = null;
      waiter.reject(new Socks5Error("SOCKS5 client closed during handshake"));
    }
  }
}

export async function performSocks5Handshake(
  socket: Duplex,
  options?: { timeoutMs?: number },
): Promise<Socks5ConnectRequest> {
  const reader = new BufferedSocketReader(socket);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const handshake = async (): Promise<Socks5ConnectRequest> => {
    const greetingHeader = await reader.readExact(2);
    if (greetingHeader[0] !== SOCKS5_VERSION) {
      throw new Socks5Error(`Unsupported SOCKS version: ${greetingHeader[0]}`);
    }
    const nMethods = greetingHeader[1] ?? 0;
    const methods = nMethods > 0 ? await reader.readExact(nMethods) : Buffer.alloc(0);
    if (!methods.includes(SOCKS5_AUTH_NONE)) {
      if (!socket.destroyed && socket.writable) {
        socket.write(Buffer.from([SOCKS5_VERSION, SOCKS5_AUTH_NO_ACCEPTABLE]));
      }
      throw new Socks5Error("SOCKS5 client did not offer NO AUTH method");
    }
    socket.write(Buffer.from([SOCKS5_VERSION, SOCKS5_AUTH_NONE]));

    const reqHeader = await reader.readExact(4);
    if (reqHeader[0] !== SOCKS5_VERSION) {
      throw new Socks5Error(`Unsupported SOCKS request version: ${reqHeader[0]}`);
    }
    const cmd = reqHeader[1];
    const atyp = reqHeader[3];

    if (cmd !== SOCKS5_CMD_CONNECT) {
      writeSocks5Reply(socket, Socks5ReplyCode.CommandNotSupported);
      throw new Socks5Error(
        `Unsupported SOCKS5 command: ${cmd}`,
        Socks5ReplyCode.CommandNotSupported,
      );
    }

    let host: string;
    if (atyp === SOCKS5_ATYP_IPV4) {
      const addr = await reader.readExact(4);
      host = `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
    } else if (atyp === SOCKS5_ATYP_DOMAIN) {
      const lenBuf = await reader.readExact(1);
      const len = lenBuf[0] ?? 0;
      if (len === 0) {
        writeSocks5Reply(socket, Socks5ReplyCode.GeneralFailure);
        throw new Socks5Error("Empty SOCKS5 domain name", Socks5ReplyCode.GeneralFailure);
      }
      const domainBuf = await reader.readExact(len);
      host = domainBuf.toString("utf8");
    } else if (atyp === SOCKS5_ATYP_IPV6) {
      const addr = await reader.readExact(16);
      host = formatIpv6Bytes(addr);
    } else {
      writeSocks5Reply(socket, Socks5ReplyCode.AddressTypeNotSupported);
      throw new Socks5Error(
        `Unsupported SOCKS5 address type: ${atyp}`,
        Socks5ReplyCode.AddressTypeNotSupported,
      );
    }

    const portBuf = await reader.readExact(2);
    const port = portBuf.readUInt16BE(0);
    if (port < 1) {
      writeSocks5Reply(socket, Socks5ReplyCode.GeneralFailure);
      throw new Socks5Error(`Invalid SOCKS5 target port: ${port}`, Socks5ReplyCode.GeneralFailure);
    }

    const leftover = reader.detach();
    return { host, port, leftover };
  };

  try {
    return await Promise.race([
      handshake(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Socks5Error("SOCKS5 handshake timed out"));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    reader.detach();
  }
}
