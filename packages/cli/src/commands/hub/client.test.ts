import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "vitest";
import { HubHttpClient } from "./hub-client/index.js";
import { HubCommandError } from "./error.js";

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

  it("reads self-contained trigger documents for export", async () => {
    const requests: Array<{ url: string | undefined; body: string }> = [];
    const origin = await startServer(
      () => ({
        status: 200,
        body: {
          triggers: [
            {
              id: "a50e05af-4f20-4c8f-8dcc-58e5ea360663",
              name: "slack-help",
              enabled: true,
              format: "single_run",
              yaml: "name: slack-help\n",
            },
          ],
        },
      }),
      requests,
    );

    const triggers = await new HubHttpClient().listTriggers(origin, "secret");

    assert.equal(triggers[0]?.yaml, "name: slack-help\n");
    assert.deepEqual(requests[0], { url: "/api/v1/triggers", body: "" });
  });

  it("validates and installs self-contained organization triggers", async () => {
    const requests: Array<{ url: string | undefined; body: string }> = [];
    const triggerId = "a50e05af-4f20-4c8f-8dcc-58e5ea360663";
    const revisionId = "2de5b143-1c88-42db-8a8d-71ca2af97830";
    const origin = await startServer(
      (url) =>
        url === "/api/v1/triggers/validate"
          ? { status: 200, body: { name: "slack-help", valid: true } }
          : {
              status: 201,
              body: { triggerId, name: "slack-help", revisionId, version: 1, active: true },
            },
      requests,
    );
    const hub = new HubHttpClient();
    const yaml = "name: slack-help\n";

    assert.deepEqual(await hub.validateTrigger(origin, "secret", yaml), {
      name: "slack-help",
      valid: true,
    });
    assert.deepEqual(await hub.installTrigger(origin, "secret", yaml), {
      triggerId,
      name: "slack-help",
      revisionId,
      version: 1,
      active: true,
    });
    assert.deepEqual(requests, [
      { url: "/api/v1/triggers/validate", body: JSON.stringify({ yaml }) },
      { url: "/api/v1/triggers/install", body: JSON.stringify({ yaml }) },
    ]);
  });

  it("reads configuration resources in the Hub's slug vocabulary", async () => {
    const requests: Array<{ url: string | undefined; body: string }> = [];
    const origin = await startServer(
      () => ({
        status: 200,
        body: {
          daemons: [{ id: "a50e05af-4f20-4c8f-8dcc-58e5ea360663", slug: "macbook" }],
          github: [
            {
              slug: "getpaseo",
              accountLogin: "getpaseo",
              accountType: "Organization",
              repositories: ["getpaseo/paseo"],
            },
          ],
          discord: [{ slug: "paseo", guildName: "Paseo" }],
          slack: [{ slug: "paseo", teamName: "Paseo" }],
          linear: [{ slug: "paseo-linear", organizationName: "Paseo" }],
        },
      }),
      requests,
    );

    const resources = await new HubHttpClient().listConfigurationResources(origin, "secret");

    assert.equal(resources.daemons[0]?.slug, "macbook");
    assert.equal(resources.discord[0]?.slug, "paseo");
    assert.equal(resources.linear[0]?.slug, "paseo-linear");
    assert.equal(requests[0]?.url, "/api/v1/configuration-resources");
  });

  it("renders file-aware Hub validation issues without exposing credentials or response bodies", async () => {
    const requests: Array<{ url: string | undefined; body: string }> = [];
    const origin = await startServer(
      () => ({
        status: 422,
        contentType: "application/problem+json",
        body: {
          type: "https://hub.test/problems/invalid-configuration-bundle",
          title: "Invalid configuration bundle",
          status: 422,
          detail: "Correct the canonical Hub bundle files. operator-secret",
          code: "invalid_configuration_bundle",
          requestId: "request-1",
          issues: [
            {
              path: [".paseo/workflows/answer.yml", "steps", "work", "agent"],
              message: "unknown named agent operator-secret",
            },
          ],
        },
      }),
      requests,
    );
    const hub = new HubHttpClient();

    await assert.rejects(
      hub.validateConfiguration({
        origin,
        apiKey: "operator-secret",
        projectSlug: "studio",
        files: [{ path: ".paseo/hub.yml", content: "sensitive bundle content" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof HubCommandError);
        assert.equal(error.message.includes("operator-secret"), false);
        assert.equal(error.message.includes("Correct the canonical"), false);
        assert.equal(error.details?.includes("operator-secret"), false);
        assert.equal(error.message.includes("sensitive bundle content"), false);
        assert.equal(error.details?.includes("sensitive bundle content"), false);
        assert.equal(
          error.details,
          ".paseo/workflows/answer.yml: steps.work.agent: unknown named agent [redacted]",
        );
        return true;
      },
    );
  });
});

interface TestResponse {
  status: number;
  body: unknown;
  contentType?: string;
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
      response.writeHead(configured.status, {
        "content-type": configured.contentType ?? "application/json",
      });
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
