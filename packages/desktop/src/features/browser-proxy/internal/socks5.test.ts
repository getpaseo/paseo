import { Duplex, PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { NetworkTunnelCloseReason } from "@getpaseo/protocol/network-tunnel";
import {
  performSocks5Handshake,
  Socks5Error,
  Socks5ReplyCode,
  socks5ReplyForTunnelCloseReason,
  writeSocks5Reply,
} from "./socks5.js";

function createSocketPair(): { client: Duplex; server: Duplex } {
  const aToB = new PassThrough();
  const bToA = new PassThrough();

  const client = new Duplex({
    read() {},
    write(chunk, encoding, cb) {
      aToB.write(chunk, encoding, cb);
    },
    final(cb) {
      aToB.end(cb);
    },
  });
  bToA.on("data", (chunk) => client.push(chunk));
  bToA.on("end", () => client.push(null));

  const server = new Duplex({
    read() {},
    write(chunk, encoding, cb) {
      bToA.write(chunk, encoding, cb);
    },
    final(cb) {
      bToA.end(cb);
    },
  });
  aToB.on("data", (chunk) => server.push(chunk));
  aToB.on("end", () => server.push(null));

  return { client, server };
}

function readBytes(stream: Duplex, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= count) {
        cleanup();
        resolve(Buffer.concat(chunks).subarray(0, count));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`Unexpected EOF after ${total} bytes (expected ${count})`));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}

describe("SOCKS5 handshake", () => {
  test("parses domain name CONNECT (ATYP=0x03) including fragmented chunks and trailing bytes", async () => {
    const { client, server } = createSocketPair();
    const handshakePromise = performSocks5Handshake(server);

    // Send greeting fragmented
    client.write(Buffer.from([0x05, 0x02]));
    client.write(Buffer.from([0x02, 0x00]));

    const methodReply = await readBytes(client, 2);
    expect(Array.from(methodReply)).toEqual([0x05, 0x00]);

    // Send domain CONNECT for web.localhost:6767 + pipelined "GET /"
    const domain = Buffer.from("web.localhost", "utf8");
    const req = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]),
      domain,
      Buffer.from([0x1a, 0x6f]), // 6767
      Buffer.from("GET /"),
    ]);
    client.write(req.subarray(0, 6));
    client.write(req.subarray(6));

    const result = await handshakePromise;
    expect(result.host).toBe("web.localhost");
    expect(result.port).toBe(6767);
    expect(result.leftover.toString("utf8")).toBe("GET /");

    writeSocks5Reply(server, Socks5ReplyCode.Succeeded);
    const reply = await readBytes(client, 10);
    expect(Array.from(reply)).toEqual([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
  });

  test("parses IPv4 CONNECT (ATYP=0x01)", async () => {
    const { client, server } = createSocketPair();
    const handshakePromise = performSocks5Handshake(server);

    client.write(Buffer.from([0x05, 0x01, 0x00]));
    await readBytes(client, 2);

    // 127.0.0.1:3000 (0x0BB8)
    client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x0b, 0xb8]));
    const result = await handshakePromise;
    expect(result).toEqual({ host: "127.0.0.1", port: 3000, leftover: Buffer.alloc(0) });
  });

  test("parses IPv6 CONNECT (ATYP=0x04)", async () => {
    const { client, server } = createSocketPair();
    const handshakePromise = performSocks5Handshake(server);

    client.write(Buffer.from([0x05, 0x01, 0x00]));
    await readBytes(client, 2);

    // ::1 port 5173 (0x1435)
    const ipv6 = Buffer.alloc(16);
    ipv6[15] = 1;
    client.write(
      Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), ipv6, Buffer.from([0x14, 0x35])]),
    );

    const result = await handshakePromise;
    expect(result.host).toBe("::1");
    expect(result.port).toBe(5173);
    expect(result.leftover.length).toBe(0);
  });

  test("rejects non-CONNECT commands with CommandNotSupported (0x07)", async () => {
    const { client, server } = createSocketPair();
    const handshakePromise = performSocks5Handshake(server);

    client.write(Buffer.from([0x05, 0x01, 0x00]));
    await readBytes(client, 2);

    // CMD=0x03 (UDP ASSOCIATE)
    client.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]));

    await expect(handshakePromise).rejects.toMatchObject({
      name: Socks5Error.name,
      replyCode: Socks5ReplyCode.CommandNotSupported,
    });
    const reply = await readBytes(client, 10);
    expect(reply[1]).toBe(Socks5ReplyCode.CommandNotSupported);
  });

  test("rejects greetings without NO AUTH (0x00) with 0xFF", async () => {
    const { client, server } = createSocketPair();
    const handshakePromise = performSocks5Handshake(server);

    client.write(Buffer.from([0x05, 0x01, 0x02])); // username/password only

    await expect(handshakePromise).rejects.toThrow(/auth/i);
    const reply = await readBytes(client, 2);
    expect(Array.from(reply)).toEqual([0x05, 0xff]);
  });

  test("maps daemon tunnel close reasons to SOCKS5 reply codes", () => {
    expect(socks5ReplyForTunnelCloseReason(NetworkTunnelCloseReason.ConnectRefused)).toBe(
      Socks5ReplyCode.ConnectionRefused,
    );
    expect(socks5ReplyForTunnelCloseReason(NetworkTunnelCloseReason.PolicyDenied)).toBe(
      Socks5ReplyCode.ConnectionNotAllowed,
    );
    expect(socks5ReplyForTunnelCloseReason(NetworkTunnelCloseReason.DnsFailed)).toBe(
      Socks5ReplyCode.HostUnreachable,
    );
    expect(socks5ReplyForTunnelCloseReason(NetworkTunnelCloseReason.HostUnreachable)).toBe(
      Socks5ReplyCode.NetworkUnreachable,
    );
  });
});
