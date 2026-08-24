#!/usr/bin/env npx tsx

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runLocalPaseo } from "./helpers/local-cli.js";

const cwd = await mkdtemp(path.join(tmpdir(), "paseo-hub-installed-"));
const requests: Array<{ url: string | undefined; body: unknown }> = [];
const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    requests.push({ url: request.url, body: JSON.parse(body) });
    const validation = request.url?.endsWith("/validate") === true;
    response.writeHead(validation ? 200 : 201, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        validation
          ? { projectSlug: "studio", valid: true }
          : {
              projectSlug: "studio",
              version: 1,
              versionId: "2de5b143-1c88-42db-8a8d-71ca2af97830",
              active: true,
            },
      ),
    );
  });
});

try {
  const workflows = path.join(cwd, ".paseo", "workflows");
  await mkdir(path.join(workflows, "partials"), { recursive: true });
  const files = [
    {
      path: ".paseo/hub.yml",
      content:
        "environments:\n  studio:\n    kind: daemon\n    daemon: local\n    cwd: /workspace\nagents:\n  codex-safe:\n    provider: codex\n    options:\n      sandbox_workspace_write:\n        writable_roots: [/var/cache/npm]\n        network_access: false\n",
    },
    {
      path: ".paseo/workflows/run.yml",
      content:
        "name: run\non: manual.run\nmax_runtime: 1h\ninputs:\n  repo:\n    type: string\n    choices: [studio]\n  agent:\n    type: string\n    choices: [codex-safe]\nsteps:\n  - id: work\n    environment: ${{ paseo.inputs.repo }}\n    max_runtime: 30m\n    idle_timeout: 5m\n    agent: ${{ paseo.inputs.agent }}\n    prompt:\n      - include: partials/instructions.md\n      - text: ${{ paseo.prompt }}\n",
    },
    {
      path: ".paseo/workflows/partials/instructions.md",
      content: "Keep structured provider options unchanged.\n",
    },
  ];
  for (const file of files) await writeFile(path.join(cwd, file.path), file.content);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const validate = await runLocalPaseo(
    [
      "hub",
      "deploy",
      "-p",
      "studio",
      "--dry-run",
      "--hub",
      origin,
      "--api-key",
      "test-secret",
      "--json",
    ],
    {},
    cwd,
  );
  assert.equal(validate.exitCode, 0, validate.stderr);
  assert.deepEqual(JSON.parse(validate.stdout), {
    projectSlug: "studio",
    valid: true,
    workflows: 1,
    origin,
  });

  const install = await runLocalPaseo(
    ["hub", "deploy", "-p", "studio", "--hub", origin, "--api-key", "test-secret", "--json"],
    {},
    cwd,
  );
  assert.equal(install.exitCode, 0, install.stderr);

  assert.deepEqual(
    requests.map(({ url, body }) => ({ url, body })),
    [
      {
        url: "/api/v1/configurations/validate",
        body: { projectSlug: "studio", files: files.toSorted(compareFiles) },
      },
      {
        url: "/api/v1/configurations/install",
        body: { projectSlug: "studio", files: files.toSorted(compareFiles) },
      },
    ],
  );
  console.log("✅ installed Hub CLI deploys and validates the canonical bundle");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(cwd, { recursive: true });
}

function compareFiles(left: { path: string }, right: { path: string }): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}
