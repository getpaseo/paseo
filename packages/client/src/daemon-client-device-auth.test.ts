import { describe, expect, test } from "vitest";
import { WSInboundMessageSchema, type WSHelloMessage } from "@getpaseo/protocol/messages";
import { DaemonClient, type DaemonClientConfig } from "./daemon-client.js";
import type { DaemonTransport, DaemonTransportFactory } from "./daemon-client-transport-types.js";

class AuthTransport implements DaemonTransport {
  private receive: (data: unknown, binary: boolean) => void | Promise<void> = () => {};
  private closed: (event?: unknown) => void = () => {};
  constructor(private readonly fixture: AuthFixture) {}
  onMessage(handler: typeof this.receive) {
    this.receive = handler;
    return () => {
      this.receive = () => {};
    };
  }
  onClose(handler: typeof this.closed) {
    this.closed = handler;
    return () => {
      this.closed = () => {};
    };
  }
  onError() {
    return () => {};
  }
  onOpen(handler: () => void) {
    queueMicrotask(handler);
    return () => {};
  }
  close() {}
  disconnect() {
    this.closed({ code: 1006 });
  }
  async send(data: string | Uint8Array | ArrayBuffer) {
    if (typeof data !== "string") return;
    const message = WSInboundMessageSchema.parse(JSON.parse(data));
    if (message.type !== "hello") return;
    this.fixture.hellos.push(message);
    const reject = message.auth?.kind === "deviceCredential" && this.fixture.rejectDevice;
    if (reject === "invalid") {
      this.closed({ code: 4002, reason: "Invalid hello" });
      return;
    }
    if (reject || !message.auth) {
      const reason = message.auth ? "incorrect_password" : "password_required";
      await this.receive(
        JSON.stringify({ type: "hello.rejected", reason, accepts: ["password"] }),
        false,
      );
      this.closed({ code: 4401 });
      return;
    }
    await this.receive(
      JSON.stringify({
        type: "session",
        message: {
          type: "status",
          payload: {
            status: "server_info",
            serverId: "srv_auth",
            hostname: "fixture",
            version: "0.15.4",
            features: { deviceCredentials: true },
          },
        },
      }),
      false,
    );
  }
}

class AuthFixture {
  hellos: WSHelloMessage[] = [];
  transports: AuthTransport[] = [];
  upgrades: Parameters<DaemonTransportFactory>[0][] = [];
  rejectDevice: false | "incorrect" | "invalid" = false;
  readonly factory: DaemonTransportFactory = (options) => {
    this.upgrades.push(options);
    const transport = new AuthTransport(this);
    this.transports.push(transport);
    return transport;
  };
  client(options: Partial<DaemonClientConfig> = {}) {
    return new DaemonClient({
      url: "ws://fixture/ws",
      clientId: "device-auth",
      transportFactory: this.factory,
      reconnect: { enabled: false },
      ...options,
    });
  }
}

const deviceCredential = { id: "dc_fixture", secret: "fixture-secret" };

describe("device hello authentication", () => {
  test.each([
    {
      options: {
        localCredential: async () => "fixture-local",
        pairingToken: "fixture-token",
        deviceCredential,
        password: "fixture-password",
      },
      kind: "localCredential",
    },
    {
      options: { pairingToken: "fixture-token", deviceCredential, password: "fixture-password" },
      kind: "pairingToken",
    },
    { options: { deviceCredential, password: "fixture-password" }, kind: "deviceCredential" },
  ])(
    "selects $kind and never sends secrets through legacy upgrade auth",
    async ({ options, kind }) => {
      const fixture = new AuthFixture();
      const client = fixture.client(options);
      try {
        await client.connect();
        expect(fixture.hellos[0]?.auth?.kind).toBe(kind);
        expect(fixture.upgrades[0]?.headers).toEqual({});
        expect(fixture.upgrades[0]?.protocols).toBeUndefined();
      } finally {
        await client.close();
      }
    },
  );

  test("uses a pairing token only on the first admitted hello", async () => {
    const fixture = new AuthFixture();
    const client = fixture.client({ pairingToken: "fixture-token", deviceCredential });
    try {
      await client.connect();
      fixture.transports[0]!.disconnect();
      await client.connect();
      expect(fixture.hellos.map((hello) => hello.auth?.kind)).toEqual([
        "pairingToken",
        "deviceCredential",
      ]);
    } finally {
      await client.close();
    }
  });

  // Only an in-channel hello.rejected forgets; a bare close may be forged by a relay.
  test.each([
    { rejection: "incorrect", forgets: 1 },
    { rejection: "invalid", forgets: 0 },
  ] as const)(
    "retries the password once after an $rejection credential (forgets: $forgets)",
    async ({ rejection, forgets }) => {
      const fixture = new AuthFixture();
      fixture.rejectDevice = rejection;
      let forgotten = 0;
      const client = fixture.client({
        deviceCredential,
        password: "fixture-password",
        onDeviceCredentialRejected: () => {
          forgotten++;
        },
      });
      try {
        await client.connect();
        expect(fixture.hellos.map((hello) => hello.auth?.kind)).toEqual([
          "deviceCredential",
          "password",
        ]);
        expect(forgotten).toBe(forgets);
      } finally {
        await client.close();
      }
    },
  );

  test("reports password required after discarding a credential when no password is saved", async () => {
    const fixture = new AuthFixture();
    fixture.rejectDevice = "incorrect";
    const client = fixture.client({ deviceCredential });
    try {
      await expect(client.connect()).rejects.toMatchObject({ reason: "password_required" });
      expect(fixture.hellos).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
