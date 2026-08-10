import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type { CliAuthorizationPoll } from "./client.js";
import { CliLoginFlow, SystemBrowser } from "./login-flow.js";

describe("Hub CLI login browser flow", () => {
  it("opens browser URLs on Windows without a command shell", async () => {
    const launches: Array<{ command: string; args: string[] }> = [];
    const browser = new SystemBrowser({
      hostPlatform: "win32",
      launch: async (command, args) => void launches.push({ command, args }),
    });

    await browser.open("https://hub.test/cli-login?code=ABCD-EFGH");

    assert.deepEqual(launches, [
      {
        command: "rundll32.exe",
        args: ["url.dll,FileProtocolHandler", "https://hub.test/cli-login?code=ABCD-EFGH"],
      },
    ]);
  });

  it("follows Hub cadence and returns the durable authorized credential", async () => {
    const journey = new LoginJourney([
      { status: "pending", interval: 5 },
      { status: "slow_down", interval: 10 },
      {
        status: "authorized",
        interval: 10,
        credential: "paseo_cli_prefix_durable-secret-value",
        organizationId: "organization-1",
      },
    ]);

    const credential = await journey.authorize();

    assert.equal(credential, "paseo_cli_prefix_durable-secret-value");
    assert.deepEqual(journey.waits, [5_000, 5_000, 10_000]);
    assert.deepEqual(journey.opened, ["https://hub.test/cli-login?code=ABCD-EFGH"]);
    assert.deepEqual(journey.instructions, ["https://hub.test/cli-login ABCD-EFGH"]);
  });

  it("does not open a browser in noninteractive mode", async () => {
    const journey = new LoginJourney(
      [
        {
          status: "authorized",
          interval: 5,
          credential: "paseo_cli_prefix_durable-secret-value",
          organizationId: "organization-1",
        },
      ],
      false,
    );

    await journey.authorize();

    assert.deepEqual(journey.opened, []);
    assert.equal(journey.instructions.length, 1);
  });
});

class LoginJourney {
  now = Date.parse("2026-08-08T10:00:00.000Z");
  readonly waits: number[] = [];
  readonly opened: string[] = [];
  readonly instructions: string[] = [];
  private pollIndex = 0;
  private readonly flow: CliLoginFlow;

  constructor(outcomes: CliAuthorizationPoll[], openBrowser = true) {
    this.flow = new CliLoginFlow({
      hub: {
        startCliAuthorization: async () => ({
          deviceCode: "device-code-with-more-than-thirty-two-characters",
          userCode: "ABCD-EFGH",
          verificationUri: "https://hub.test/cli-login",
          verificationUriComplete: "https://hub.test/cli-login?code=ABCD-EFGH",
          expiresAt: "2026-08-08T10:10:00.000Z",
          interval: 5,
        }),
        pollCliAuthorization: async () => {
          const outcome = outcomes[this.pollIndex];
          this.pollIndex += 1;
          if (outcome === undefined) throw new Error("No poll outcome remains");
          return outcome;
        },
      },
      waiter: {
        wait: async (milliseconds) => {
          this.waits.push(milliseconds);
          this.now += milliseconds;
        },
        now: () => this.now,
      },
      browser: { open: async (url) => void this.opened.push(url) },
      instructions: (url, code) => void this.instructions.push(`${url} ${code}`),
      openBrowser,
    });
  }

  authorize(): Promise<string> {
    return this.flow.authorize("https://hub.test");
  }
}
