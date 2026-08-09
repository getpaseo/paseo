import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "vitest";
import { HubHttpClient } from "./client.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("Hub HTTP client", () => {
  it("uses the paired CLI authorization contract", async () => {
    const requests: Array<{ url: string | undefined; body: string }> = [];
    const origin = await startServer((url) => {
      if (url === "/api/v1/cli-authorizations") {
        return {
          status: 201,
          body: {
            deviceCode: "device-code-with-more-than-thirty-two-characters",
            userCode: "ABCD-EFGH",
            verificationUri: `${origin}/cli-login`,
            verificationUriComplete: `${origin}/cli-login?code=ABCD-EFGH`,
            expiresAt: "2026-08-08T14:00:00.000Z",
            interval: 5,
          },
        };
      }
      return {
        status: 200,
        body: {
          status: "authorized",
          interval: 5,
          credential: "paseo_cli_prefix_durable-secret-value",
          organizationId: "organization-1",
        },
      };
    }, requests);
    const hub = new HubHttpClient();

    const started = await hub.startCliAuthorization(origin);
    const polled = await hub.pollCliAuthorization(origin, started.deviceCode, 1_000);

    assert.equal(polled.status, "authorized");
    assert.deepEqual(requests, [
      { url: "/api/v1/cli-authorizations", body: "{}" },
      {
        url: "/api/v1/cli-authorizations/poll",
        body: JSON.stringify({ deviceCode: "device-code-with-more-than-thirty-two-characters" }),
      },
    ]);
  });

  it("validates projects and enrollment responses once at the HTTP boundary", async () => {
    const requests: Array<{ url: string | undefined; body: string }> = [];
    const origin = await startServer((url) => {
      if (url === "/api/v1/projects") {
        return {
          status: 200,
          body: {
            projects: [
              {
                id: "a50e05af-4f20-4c8f-8dcc-58e5ea360663",
                slug: "paseo",
                name: "Paseo",
              },
            ],
          },
        };
      }
      return {
        status: 201,
        body: {
          token: "one-time-enrollment-token-with-enough-length",
          expiresAt: "2026-08-08T14:00:00.000Z",
        },
      };
    }, requests);
    const hub = new HubHttpClient();

    const projects = await hub.listProjects(origin, "human-secret");
    const token = await hub.issueEnrollmentToken(origin, "human-secret");

    assert.equal(projects[0]?.slug, "paseo");
    assert.equal(token, "one-time-enrollment-token-with-enough-length");
    assert.deepEqual(
      requests.map((request) => request.url),
      ["/api/v1/projects", "/api/v1/daemons/enrollment-tokens"],
    );
  });
});

interface TestResponse {
  status: number;
  body: unknown;
}

async function startServer(
  responseFor: (url: string | undefined) => TestResponse,
  requests: Array<{ url: string | undefined; body: string }>,
): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ url: request.url, body });
      const configured = responseFor(request.url);
      response.writeHead(configured.status, { "content-type": "application/json" });
      response.end(JSON.stringify(configured.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
