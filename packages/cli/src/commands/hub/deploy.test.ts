import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderError, toCommandError } from "../../output/index.js";
import { createHubCommand } from "./index.js";
import { runHubDeploy } from "./deploy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("hub deploy", () => {
  it("deploys the default file with its project metadata and exact YAML through env credentials", async () => {
    const cwd = await temporaryDirectory();
    const configurationDirectory = path.join(cwd, ".paseo");
    const yaml = "project: studio-api\r\nenvironments: []\r\ntriggers: []\r\n";
    await mkdir(configurationDirectory);
    await writeFile(path.join(configurationDirectory, "hub.yml"), yaml);

    const hub = await startHub();

    try {
      const result = await runHubDeploy(
        {},
        {
          cwd,
          env: { PASEO_HUB_URL: hub.origin, PASEO_HUB_API_KEY: "test-operator-secret" },
        },
      );

      expect(await hub.received).toEqual({
        method: "POST",
        url: "/api/v1/configurations/install",
        authorization: "Bearer test-operator-secret",
        body: JSON.stringify({ projectSlug: "studio-api", yaml }),
      });
      expect(result.data).toEqual({
        projectSlug: "studio-api",
        version: 7,
        versionId: "2de5b143-1c88-42db-8a8d-71ca2af97830",
        active: true,
      });
    } finally {
      await hub.close();
    }
  });

  it("uses an explicit file and lets -p override project metadata without rewriting YAML", async () => {
    const cwd = await temporaryDirectory();
    const yaml = "project: file-project\nenvironments: []\ntriggers: []\n";
    await writeFile(path.join(cwd, "production.yml"), yaml);
    const hub = await startHub();

    try {
      await runHubDeploy(
        {
          file: "production.yml",
          project: "flag-project",
          hub: hub.origin,
          apiKey: "flag-secret",
        },
        { cwd, env: {} },
      );

      expect(await hub.received).toMatchObject({
        authorization: "Bearer flag-secret",
        body: JSON.stringify({ projectSlug: "flag-project", yaml }),
      });
    } finally {
      await hub.close();
    }
  });

  it("deploys mixed inline and partial prompts with only the referenced partial files", async () => {
    const cwd = await temporaryDirectory();
    const configurationDirectory = path.join(cwd, ".paseo");
    const partialDirectory = path.join(configurationDirectory, "partials", "docs");
    const yaml = [
      "project: studio-api",
      "triggers:",
      "  - steps:",
      "      - prompt:",
      "          - text: Inline request",
      "          - include: docs/safety.md",
      "          - include: docs/release.md",
      "unknownNestedInclude: ignored.md",
      "",
    ].join("\n");
    const safety = "Follow the safety checklist.\n{ include: nested.md }";
    const release = "Use the release checklist.";
    await mkdir(partialDirectory, { recursive: true });
    await writeFile(path.join(configurationDirectory, "hub.yml"), yaml);
    await writeFile(path.join(partialDirectory, "safety.md"), safety);
    await writeFile(path.join(partialDirectory, "release.md"), release);
    const hub = await startHub();

    try {
      await runHubDeploy(
        {},
        { cwd, env: { PASEO_HUB_URL: hub.origin, PASEO_HUB_API_KEY: "bundle-secret" } },
      );

      expect(await hub.received).toEqual({
        method: "POST",
        url: "/api/v1/configurations/install",
        authorization: "Bearer bundle-secret",
        body: JSON.stringify({
          projectSlug: "studio-api",
          yaml,
          partials: [
            { path: "docs/safety.md", content: safety },
            { path: "docs/release.md", content: release },
          ],
        }),
      });
    } finally {
      await hub.close();
    }
  });

  it("anchors explicit configuration files and their partial bundle at the current project root", async () => {
    const cwd = await temporaryDirectory();
    const configurationDirectory = path.join(cwd, "configs");
    const partialDirectory = path.join(cwd, ".paseo", "partials");
    const yaml =
      "project: explicit-project\ntriggers:\n  - steps:\n      - prompt:\n          - include: instructions.md\n";
    const partial = "Explicit project-root partial";
    await mkdir(configurationDirectory, { recursive: true });
    await mkdir(partialDirectory, { recursive: true });
    await writeFile(path.join(configurationDirectory, "production.yml"), yaml);
    await writeFile(path.join(partialDirectory, "instructions.md"), partial);
    const hub = await startHub();

    try {
      await runHubDeploy(
        { file: "configs/production.yml", hub: hub.origin, apiKey: "explicit-secret" },
        { cwd, env: {} },
      );

      expect(await hub.received).toMatchObject({
        body: JSON.stringify({
          projectSlug: "explicit-project",
          yaml,
          partials: [{ path: "instructions.md", content: partial }],
        }),
      });
    } finally {
      await hub.close();
    }
  });

  it("does not search parent directories or alternate default filenames", async () => {
    const parent = await temporaryDirectory();
    const cwd = path.join(parent, "child");
    await mkdir(path.join(parent, ".paseo"));
    await mkdir(path.join(cwd, ".paseo"), { recursive: true });
    await writeFile(path.join(parent, ".paseo", "hub.yml"), "project: parent-project\n");
    await writeFile(path.join(cwd, ".paseo", "hub.yaml"), "project: alternate-project\n");

    await expect(
      runHubDeploy({ hub: "https://hub.example.com", apiKey: "unused-secret" }, { cwd, env: {} }),
    ).rejects.toMatchObject({
      code: "HUB_CONFIGURATION_UNREADABLE",
      message: "Could not read Hub configuration at .paseo/hub.yml. Pass an existing YAML file.",
    });
  });

  it("requires an explicit project when the YAML omits project metadata", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(path.join(cwd, "hub.yml"), "environments: []\ntriggers: []\n");

    await expect(
      runHubDeploy(
        { file: "hub.yml", hub: "https://hub.example.com", apiKey: "unused-secret" },
        { cwd, env: {} },
      ),
    ).rejects.toMatchObject({
      message: "Project is required. Pass --project <slug> or add top-level project to the YAML.",
    });
  });

  it("fails locally for a missing partial without sending a request", async () => {
    const cwd = await projectFile(
      "project: studio-api\ntriggers:\n  - steps:\n      - prompt:\n          - include: missing.md\n",
    );
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "missing-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_PARTIAL_MISSING",
        message: "Referenced Hub partial missing.md does not exist.",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it.each([
    "../secret.md",
    "%2e%2e/secret.md",
    "/etc/passwd",
    "\\\\server\\share\\secret.md",
    "C:\\secret.md",
  ])("fails locally for an unsafe partial path %s without sending a request", async (include) => {
    const cwd = await projectFile(
      `project: studio-api\ntriggers:\n  - steps:\n      - prompt:\n          - include: ${JSON.stringify(include)}\n`,
    );
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "unsafe-path-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({ code: "HUB_PARTIAL_PATH_INVALID" });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally when a referenced partial is a directory", async () => {
    const cwd = await projectFile(
      "project: studio-api\ntriggers:\n  - steps:\n      - prompt:\n          - include: docs\n",
    );
    await mkdir(path.join(cwd, ".paseo", "partials", "docs"), { recursive: true });
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "directory-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_PARTIAL_NOT_FILE",
        message: "Referenced Hub partial docs must be a regular file.",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally when a referenced partial cannot be read", async () => {
    const cwd = await projectFile(
      "project: studio-api\ntriggers:\n  - steps:\n      - prompt:\n          - include: unreadable.md\n",
    );
    const partial = path.join(cwd, ".paseo", "partials", "unreadable.md");
    await mkdir(path.dirname(partial), { recursive: true });
    await writeFile(partial, "secret instructions");
    await chmod(partial, 0o000);
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "unreadable-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_PARTIAL_UNREADABLE",
        message:
          "Could not read referenced Hub partial unreadable.md. Check the file and permissions.",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally for duplicate normalized partial references", async () => {
    const cwd = await projectFile(
      "project: studio-api\ntriggers:\n  - steps:\n      - prompt:\n          - include: docs/safety.md\n          - include: docs\\safety.md\n",
    );
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "duplicate-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_PARTIAL_DUPLICATE",
        message:
          "Hub partial docs/safety.md is referenced more than once. Remove the duplicate include.",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally when the configuration exceeds the YAML size limit", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, ".paseo"));
    await writeFile(
      path.join(cwd, ".paseo", "hub.yml"),
      `project: studio-api\n${"#".repeat(1_000_000)}`,
    );
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "large-yaml-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_CONFIGURATION_TOO_LARGE",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally when a partial exceeds its content size limit", async () => {
    const cwd = await projectFile(
      "project: studio-api\ntriggers:\n  - steps:\n      - prompt:\n          - include: large.md\n",
    );
    await writeFile(path.join(cwd, ".paseo", "partials", "large.md"), "x".repeat(1_000_001));
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "large-partial-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_PARTIAL_TOO_LARGE",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally when the referenced partial bundle exceeds its combined size limit", async () => {
    const cwd = await projectFile(
      [
        "project: studio-api",
        "triggers:",
        "  - steps:",
        "      - prompt:",
        ...Array.from({ length: 6 }, (_, index) => `          - include: part-${index}.md`),
        "",
      ].join("\n"),
    );
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        writeFile(path.join(cwd, ".paseo", "partials", `part-${index}.md`), "x".repeat(900_000)),
      ),
    );
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "large-bundle-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_PARTIAL_BUNDLE_TOO_LARGE",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally for an explicit configuration path outside the project root", async () => {
    const cwd = await temporaryDirectory();
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy(
          { file: "../hub.yml", hub: hub.origin, apiKey: "traversal-secret" },
          { cwd, env: {} },
        ),
      ).rejects.toMatchObject({
        code: "HUB_CONFIGURATION_PATH_INVALID",
        message:
          "Hub configuration path must stay within the current project root; parent-directory paths are not allowed.",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally when the configuration is a directory", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, ".paseo", "hub.yml"), { recursive: true });
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy(
          { hub: hub.origin, apiKey: "configuration-directory-secret" },
          { cwd, env: {} },
        ),
      ).rejects.toMatchObject({
        code: "HUB_CONFIGURATION_NOT_FILE",
        message: "Hub configuration at .paseo/hub.yml must be a regular file.",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally when the configuration cannot be read", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, ".paseo"));
    const configuration = path.join(cwd, ".paseo", "hub.yml");
    await writeFile(configuration, "project: studio-api\n");
    await chmod(configuration, 0o000);
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy(
          { hub: hub.origin, apiKey: "configuration-unreadable-secret" },
          { cwd, env: {} },
        ),
      ).rejects.toMatchObject({ code: "HUB_CONFIGURATION_UNREADABLE" });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally when the partial count exceeds the bundle limit", async () => {
    const cwd = await projectFile(
      [
        "project: studio-api",
        "triggers:",
        "  - steps:",
        "      - prompt:",
        ...Array.from({ length: 101 }, (_, index) => `          - include: part-${index}.md`),
        "",
      ].join("\n"),
    );
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "partial-count-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_PARTIAL_LIMIT_EXCEEDED",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("fails locally when a canonical partial path exceeds its length limit", async () => {
    const include = `${"a".repeat(497)}.md`;
    const cwd = await projectFile(
      `project: studio-api\ntriggers:\n  - steps:\n      - prompt:\n          - include: ${JSON.stringify(include)}\n`,
    );
    const hub = await startHub();

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "partial-path-length-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_PARTIAL_PATH_TOO_LONG",
      });
      expect(hub.requestCount()).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("requires Hub origin and API key with actionable flag and env guidance", async () => {
    await expect(runHubDeploy({}, { cwd: "/unused", env: {} })).rejects.toMatchObject({
      message: "Hub origin is required. Pass --hub <origin> or set PASEO_HUB_URL.",
    });
    await expect(
      runHubDeploy({ hub: "https://hub.example.com" }, { cwd: "/unused", env: {} }),
    ).rejects.toMatchObject({
      message: "Hub API key is required. Pass --api-key <secret> or set PASEO_HUB_API_KEY.",
    });
  });

  it.each([
    "ftp://hub.example.com",
    "https://user:password@hub.example.com",
    "https://hub.example.com/path",
    "https://hub.example.com?debug=true",
    "https://hub.example.com#debug",
  ])("rejects a non-origin Hub URL: %s", async (hub) => {
    await expect(
      runHubDeploy({ hub, apiKey: "unused-secret" }, { cwd: "/unused", env: {} }),
    ).rejects.toMatchObject({
      message: "Hub URL must be an HTTP or HTTPS origin without credentials, path, query, or hash.",
    });
  });

  it("shows RFC 9457 detail and field issues without raw server extensions", async () => {
    const cwd = await projectFile("project: studio-api\n");
    const hub = await startHub({
      status: 422,
      contentType: "application/problem+json",
      body: {
        type: "https://hub.example.com/problems/configuration-invalid",
        title: "Configuration validation failed",
        status: 422,
        detail: "Fix the invalid configuration fields.",
        errors: [{ field: "triggers[0].steps[0].agent.provider", message: "Unknown provider" }],
        internalTrace: "do-not-expose-this-trace",
      },
    });

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "validation-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_VALIDATION_FAILED",
        message: "Configuration validation failed: Fix the invalid configuration fields.",
        details: "triggers[0].steps[0].agent.provider: Unknown provider",
      });
    } finally {
      await hub.close();
    }
  });

  it("reports malformed successful responses without exposing their body", async () => {
    const cwd = await projectFile("project: studio-api\n");
    const hub = await startHub({ status: 201, body: { projectSlug: "studio-api", version: "7" } });

    try {
      await expect(
        runHubDeploy({ hub: hub.origin, apiKey: "response-secret" }, { cwd, env: {} }),
      ).rejects.toMatchObject({
        code: "HUB_INVALID_RESPONSE",
        message: "Hub returned a malformed deployment response.",
      });
    } finally {
      await hub.close();
    }
  });

  it("reports network failures honestly", async () => {
    const cwd = await projectFile("project: studio-api\n");
    const hub = await startHub();
    await hub.close();

    await expect(
      runHubDeploy({ hub: hub.origin, apiKey: "network-secret" }, { cwd, env: {} }),
    ).rejects.toMatchObject({
      code: "HUB_NETWORK_ERROR",
      message: `Could not reach Paseo Hub at ${hub.origin}. Check the Hub URL and network connection.`,
    });
  });

  it("redacts the operator key from problem detail, field issues, and serialized errors", async () => {
    const secret = "operator-secret-must-not-leak";
    const cwd = await projectFile("project: studio-api\n");
    const hub = await startHub({
      status: 401,
      contentType: "application/problem+json",
      body: {
        title: `Rejected key ${secret}`,
        status: 401,
        detail: `Authorization Bearer ${secret} is invalid`,
        errors: [{ field: "apiKey", message: secret }],
      },
    });

    try {
      const error = await runHubDeploy({ hub: hub.origin, apiKey: secret }, { cwd, env: {} }).catch(
        (failure: unknown) => failure,
      );
      const jsonOutput = renderError(toCommandError(error), { format: "json" });
      expect(jsonOutput).not.toContain(secret);
      expect(error).toMatchObject({
        message: "Rejected key [redacted]: Authorization Bearer [redacted] is invalid",
        details: "apiKey: [redacted]",
      });
    } finally {
      await hub.close();
    }
  });

  it("wires deploy with its exact default file and explicit target options", () => {
    const deploy = createHubCommand().commands.find((command) => command.name() === "deploy");
    const help = deploy?.helpInformation();

    expect(deploy?.registeredArguments[0]?.name()).toBe("file");
    expect(deploy?.registeredArguments[0]?.defaultValue).toBe(".paseo/hub.yml");
    expect(help).toContain("-p, --project <slug>");
    expect(help).toContain("--hub <origin>");
    expect(help).toContain("--api-key <secret>");
    expect(help).not.toContain("organization");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-hub-deploy-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function projectFile(yaml: string): Promise<string> {
  const cwd = await temporaryDirectory();
  await mkdir(path.join(cwd, ".paseo"));
  await mkdir(path.join(cwd, ".paseo", "partials"));
  await writeFile(path.join(cwd, ".paseo", "hub.yml"), yaml);
  return cwd;
}

interface HubResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

interface ReceivedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

interface TestHub {
  origin: string;
  received: Promise<ReceivedRequest>;
  requestCount(): number;
  close(): Promise<void>;
}

async function startHub(
  configuredResponse: HubResponse = {
    status: 201,
    body: {
      projectSlug: "studio-api",
      version: 7,
      versionId: "2de5b143-1c88-42db-8a8d-71ca2af97830",
      active: true,
    },
  },
): Promise<TestHub> {
  let requestCount = 0;
  let resolveRequest: (request: ReceivedRequest) => void;
  const received = new Promise<ReceivedRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((request, response) => {
    requestCount += 1;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      resolveRequest({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(configuredResponse.status, {
        "content-type": configuredResponse.contentType ?? "application/json",
      });
      response.end(JSON.stringify(configuredResponse.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not bind");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    received,
    requestCount: () => requestCount,
    close: () => closeServer(server),
  };
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
