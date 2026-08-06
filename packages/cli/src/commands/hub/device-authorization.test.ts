import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DeviceAuthorizationWorkflow, SystemBrowser } from "./device-authorization.js";
import type {
  CloudDeviceAuthorization,
  DeviceAuthorizationPoll,
} from "./cloud-device-authorization.js";
import { createHubCommand } from "./index.js";

describe("Hub device authorization", () => {
  it("opens activation URLs on Windows without a command shell", async () => {
    const launches: Array<{ command: string; args: string[] }> = [];
    const browser = new SystemBrowser({
      hostPlatform: "win32",
      launch: async (command, args) => void launches.push({ command, args }),
    });

    await browser.open("https://cloud.paseo.test/activate?code=ABCD-EFGH-JKLMN");

    assert.deepEqual(launches, [
      {
        command: "rundll32.exe",
        args: [
          "url.dll,FileProtocolHandler",
          "https://cloud.paseo.test/activate?code=ABCD-EFGH-JKLMN",
        ],
      },
    ]);
  });

  it("opens the browser, follows Cloud cadence, and returns the approved enrollment token", async () => {
    const cloud = new FakeCloud([
      { status: "pending", interval: 5 },
      { status: "slow_down", interval: 10 },
      { status: "approved", interval: 10, enrollmentToken: "approved-enrollment-token-1234567890" },
    ]);
    const authorization = new AuthorizationJourney(cloud);

    const token = await authorization.approve("https://cloud.paseo.test", "Studio Mac");

    assert.equal(token, "approved-enrollment-token-1234567890");
    assert.deepEqual(authorization.observed(), {
      starts: [{ hubUrl: "https://cloud.paseo.test", displayName: "Studio Mac" }],
      polls: [
        {
          hubUrl: "https://cloud.paseo.test",
          deviceCode: "device-code-with-more-than-thirty-two-characters",
          timeoutMilliseconds: 595_000,
        },
        {
          hubUrl: "https://cloud.paseo.test",
          deviceCode: "device-code-with-more-than-thirty-two-characters",
          timeoutMilliseconds: 590_000,
        },
        {
          hubUrl: "https://cloud.paseo.test",
          deviceCode: "device-code-with-more-than-thirty-two-characters",
          timeoutMilliseconds: 580_000,
        },
      ],
      waits: [5_000, 5_000, 10_000],
      opened: ["https://cloud.paseo.test/activate?code=ABCD-EFGH-JKLMN"],
      instructions: ["https://cloud.paseo.test/activate ABCD-EFGH-JKLMN"],
    });
  });

  it("stops without an enrollment token when the browser denies the request", async () => {
    const authorization = new AuthorizationJourney(
      new FakeCloud([{ status: "denied", interval: 5 }]),
    );

    await assert.rejects(authorization.approve("https://cloud.paseo.test", "Studio Mac"), {
      message: "Daemon registration was denied",
    });
  });

  it("recovers the approved authority after its first poll response is lost", async () => {
    const authorization = new AuthorizationJourney(
      new FakeCloud([
        { status: "retry_later" },
        {
          status: "approved",
          interval: 5,
          enrollmentToken: "stable-enrollment-token-after-response-loss",
        },
      ]),
    );

    const token = await authorization.approve("https://cloud.paseo.test", "Studio Mac");

    assert.equal(token, "stable-enrollment-token-after-response-loss");
    assert.deepEqual(authorization.observed().waits, [5_000, 5_000]);
  });

  it("retries timeout failures only while the fixed authorization expiry remains", async () => {
    const authorization = new AuthorizationJourney(
      new FakeCloud(
        [{ status: "retry_later" }, { status: "retry_later" }],
        "2026-07-18T12:00:11.000Z",
      ),
    );

    await assert.rejects(authorization.approve("https://cloud.paseo.test", "Studio Mac"), {
      message: "Daemon registration expired",
    });
    assert.deepEqual(authorization.observed().waits, [5_000, 5_000, 1_000]);
    assert.deepEqual(
      authorization.observed().polls.map(({ timeoutMilliseconds }) => timeoutMilliseconds),
      [6_000, 1_000],
    );
  });

  it("stops without an enrollment token when the request expires", async () => {
    const authorization = new AuthorizationJourney(
      new FakeCloud([{ status: "expired", interval: 5 }]),
    );

    await assert.rejects(authorization.approve("https://cloud.paseo.test", "Studio Mac"), {
      message: "Daemon registration expired",
    });
  });

  it("connects the real hub command with a browser-approved token", async () => {
    const daemon = new FakeDaemon();

    await createHubCommand({
      connect: async () => daemon,
      authorize: async (url, displayName) => {
        assert.equal(url, "https://cloud.paseo.test");
        assert.equal(displayName, "Studio Mac");
        return "approved-enrollment-token-1234567890";
      },
      displayName: () => "Studio Mac",
    }).parseAsync(["node", "paseo hub", "connect", "https://cloud.paseo.test", "--json"], {
      from: "node",
    });

    assert.deepEqual(daemon.connections, [
      {
        url: "https://cloud.paseo.test",
        token: "approved-enrollment-token-1234567890",
      },
    ]);
    assert.equal(daemon.closed, true);
  });

  it("bounds the default daemon name before starting browser authorization", async () => {
    const daemon = new FakeDaemon();
    const names: string[] = [];

    await createHubCommand({
      connect: async () => daemon,
      authorize: async (_url, displayName) => {
        names.push(displayName);
        return "approved-enrollment-token-1234567890";
      },
      displayName: () => `  ${"very-long-hostname".repeat(10)}  `,
    }).parseAsync(["node", "paseo hub", "connect", "https://cloud.paseo.test", "--json"], {
      from: "node",
    });

    assert.deepEqual(names, ["very-long-hostname".repeat(10).slice(0, 100)]);
  });
});

class AuthorizationJourney {
  private now = Date.parse("2026-07-18T12:00:00.000Z");
  private readonly waits: number[] = [];
  private readonly opened: string[] = [];
  private readonly instructions: string[] = [];
  private readonly workflow: DeviceAuthorizationWorkflow;

  constructor(private readonly cloud: FakeCloud) {
    this.workflow = new DeviceAuthorizationWorkflow({
      cloud,
      waiter: {
        wait: async (milliseconds) => {
          this.waits.push(milliseconds);
          this.now += milliseconds;
        },
        now: () => this.now,
      },
      browser: { open: async (url) => void this.opened.push(url) },
      reporter: {
        instructions: (url, code) => void this.instructions.push(`${url} ${code}`),
      },
    });
  }

  approve(hubUrl: string, displayName: string): Promise<string> {
    return this.workflow.authorize(hubUrl, displayName);
  }

  observed() {
    return {
      starts: this.cloud.starts,
      polls: this.cloud.polls,
      waits: this.waits,
      opened: this.opened,
      instructions: this.instructions,
    };
  }
}

class FakeCloud implements CloudDeviceAuthorization {
  readonly starts: Array<{ hubUrl: string; displayName: string }> = [];
  readonly polls: Array<{
    hubUrl: string;
    deviceCode: string;
    timeoutMilliseconds: number;
  }> = [];

  constructor(
    private readonly outcomes: DeviceAuthorizationPoll[],
    private readonly expiresAt = "2026-07-18T12:10:00.000Z",
  ) {}

  async start(hubUrl: string, displayName: string) {
    this.starts.push({ hubUrl, displayName });
    return {
      deviceCode: "device-code-with-more-than-thirty-two-characters",
      userCode: "ABCD-EFGH-JKLMN",
      verificationUri: "https://cloud.paseo.test/activate",
      verificationUriComplete: "https://cloud.paseo.test/activate?code=ABCD-EFGH-JKLMN",
      expiresAt: this.expiresAt,
      interval: 5,
    };
  }

  async poll(
    hubUrl: string,
    deviceCode: string,
    timeoutMilliseconds: number,
  ): Promise<DeviceAuthorizationPoll> {
    this.polls.push({ hubUrl, deviceCode, timeoutMilliseconds });
    const outcome = this.outcomes[this.polls.length - 1];
    if (outcome === undefined) throw new Error("No Cloud poll outcome remains");
    return outcome;
  }
}

class FakeDaemon {
  readonly connections: Array<{ url: string; token: string }> = [];
  closed = false;

  async getHubStatus() {
    return { status: hubStatus("not_connected") };
  }

  async connectHub(url: string, token: string) {
    this.connections.push({ url, token });
    return { status: hubStatus("connected") };
  }

  async disconnectHub() {
    return { status: hubStatus("not_connected") };
  }

  async close() {
    this.closed = true;
  }
}

function hubStatus(state: string) {
  return {
    state,
    daemonId: state === "connected" ? "daemon-1" : null,
    hubOrigin: state === "connected" ? "https://cloud.paseo.test" : null,
    scopes: state === "connected" ? ["hub.execution.*"] : [],
    connectedAt: null,
    lastError: null,
  };
}
