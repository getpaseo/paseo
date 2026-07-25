import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "vitest";
import { CloudDeviceAuthorizationClient } from "./cloud-device-authorization.js";

describe("Cloud device authorization", () => {
  it("accepts loopback HTTP activation URLs", async () => {
    const cloud = await RegistrationCloud.start("loopback-authorization");
    try {
      const authorization = await new CloudDeviceAuthorizationClient().start(
        cloud.origin,
        "Studio Mac",
      );

      assert.equal(authorization.verificationUri, `${cloud.origin}/activate`);
      assert.equal(
        authorization.verificationUriComplete,
        `${cloud.origin}/activate?code=ABCD-EFGH-JKLMN`,
      );
    } finally {
      await cloud.stop();
    }
  });

  it("rejects a non-web activation URL at the Cloud boundary", async () => {
    const cloud = await RegistrationCloud.start("non-web-authorization");
    try {
      await assert.rejects(new CloudDeviceAuthorizationClient().start(cloud.origin, "Studio Mac"), {
        name: "ZodError",
      });
      assert.deepEqual(cloud.receivedPaths, ["/api/device-authorizations/"]);
    } finally {
      await cloud.stop();
    }
  });

  it("fails when start headers arrive but the response body stalls", async () => {
    const cloud = await RegistrationCloud.start("stalled-start-body");
    try {
      await assert.rejects(
        new CloudDeviceAuthorizationClient(100).start(cloud.origin, "Studio Mac"),
        { message: "Cloud registration start timed out" },
      );
      assert.deepEqual(cloud.receivedPaths, ["/api/device-authorizations/"]);
    } finally {
      await cloud.stop();
    }
  });

  it("retries when poll headers arrive but the response body stalls", async () => {
    const cloud = await RegistrationCloud.start("stalled-poll-body");
    try {
      const outcome = await new CloudDeviceAuthorizationClient().poll(
        cloud.origin,
        "device-code-with-more-than-thirty-two-characters",
        100,
      );

      assert.deepEqual(outcome, { status: "retry_later" });
      assert.deepEqual(cloud.receivedPaths, ["/api/device-authorizations/poll"]);
    } finally {
      await cloud.stop();
    }
  });

  it("retries when a poll response body resets after headers arrive", async () => {
    const cloud = await RegistrationCloud.start("reset-poll-body");
    try {
      const outcome = await new CloudDeviceAuthorizationClient().poll(
        cloud.origin,
        "device-code-with-more-than-thirty-two-characters",
        1_000,
      );

      assert.deepEqual(outcome, { status: "retry_later" });
      assert.deepEqual(cloud.receivedPaths, ["/api/device-authorizations/poll"]);
    } finally {
      await cloud.stop();
    }
  });

  it("rejects a completed malformed poll response", async () => {
    const cloud = await RegistrationCloud.start("malformed-poll-body");
    try {
      await assert.rejects(
        new CloudDeviceAuthorizationClient().poll(
          cloud.origin,
          "device-code-with-more-than-thirty-two-characters",
          1_000,
        ),
        { name: "SyntaxError" },
      );
    } finally {
      await cloud.stop();
    }
  });

  it("rejects a completed poll response with an invalid shape", async () => {
    const cloud = await RegistrationCloud.start("invalid-poll-body");
    try {
      await assert.rejects(
        new CloudDeviceAuthorizationClient().poll(
          cloud.origin,
          "device-code-with-more-than-thirty-two-characters",
          1_000,
        ),
        { name: "ZodError" },
      );
    } finally {
      await cloud.stop();
    }
  });
});

type RegistrationCloudResponse =
  | "loopback-authorization"
  | "non-web-authorization"
  | "stalled-start-body"
  | "stalled-poll-body"
  | "reset-poll-body"
  | "malformed-poll-body"
  | "invalid-poll-body";

class RegistrationCloud {
  readonly receivedPaths: string[] = [];

  private constructor(
    readonly origin: string,
    private readonly server: Server,
  ) {}

  static async start(responseBody: RegistrationCloudResponse): Promise<RegistrationCloud> {
    let cloud: RegistrationCloud;
    const server = createServer((request, response) => {
      if (request.url !== undefined) cloud.receivedPaths.push(request.url);
      response.writeHead(200, { "content-type": "application/json" });
      if (responseBody === "malformed-poll-body") {
        response.end("not-json");
        return;
      }
      if (responseBody === "invalid-poll-body") {
        response.end('{"status":"pending"}');
        return;
      }
      if (responseBody === "non-web-authorization") {
        response.end(
          JSON.stringify({
            deviceCode: "device-code-with-more-than-thirty-two-characters",
            userCode: "ABCD-EFGH-JKLMN",
            verificationUri: "https://cloud.paseo.test/activate",
            verificationUriComplete: "file:///tmp/paseo-activate",
            expiresAt: "2026-07-18T12:10:00.000Z",
            interval: 5,
          }),
        );
        return;
      }
      if (responseBody === "loopback-authorization") {
        response.end(
          JSON.stringify({
            deviceCode: "device-code-with-more-than-thirty-two-characters",
            userCode: "ABCD-EFGH-JKLMN",
            verificationUri: `${cloud.origin}/activate`,
            verificationUriComplete: `${cloud.origin}/activate?code=ABCD-EFGH-JKLMN`,
            expiresAt: "2026-07-18T12:10:00.000Z",
            interval: 5,
          }),
        );
        return;
      }
      if (responseBody === "stalled-start-body") {
        response.write('{"deviceCode":"device-code-with-more-than-thirty-two-characters"');
        return;
      }
      if (responseBody === "reset-poll-body") {
        response.flushHeaders();
        response.write('{"status":"pending"');
        setImmediate(() => response.socket?.destroy());
        return;
      }
      response.write('{"status":"pending","interval":5');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    cloud = new RegistrationCloud(`http://127.0.0.1:${address.port}`, server);
    return cloud;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
