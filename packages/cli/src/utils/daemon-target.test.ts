import { test, expect } from "vitest";
import { selectDaemonTarget, describeDaemonTarget } from "./daemon-target.js";
import { resolveDaemonCredential, resolveClientPaseoHome } from "./client.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("explicit selectors win over both environment selectors", () => {
  const env = { PASEO_HOME: "/tmp/a", PASEO_HOST: "unused:12345" };
  expect(selectDaemonTarget({ home: "/tmp/b" }, env)).toEqual({ kind: "instance", home: "/tmp/b" });
  expect(selectDaemonTarget({ host: "chosen:23456" }, env)).toEqual({
    kind: "endpoint",
    host: "chosen:23456",
  });
  expect(() => selectDaemonTarget({}, env)).toThrow();
  expect(() => selectDaemonTarget({ home: "/tmp/b", host: "chosen:23456" }, {})).toThrow();
});

test("endpoint connections resolve local credentials from PASEO_HOME", () => {
  expect(
    resolveClientPaseoHome(
      { kind: "endpoint", host: "localhost:6767" },
      { PASEO_HOME: "/tmp/custom-home" },
    ),
  ).toBe("/tmp/custom-home");
});

test("local operations ignore routing environment but reject an explicit endpoint", () => {
  expect(
    selectDaemonTarget({}, { PASEO_HOME: "/tmp/b", PASEO_HOST: "unused:12345" }, true),
  ).toEqual({ kind: "instance", home: "/tmp/b" });
  expect(() => selectDaemonTarget({ host: "chosen:23456" }, {}, true)).toThrow();
});

test("endpoint descriptions redact pairing material and credentials", () => {
  expect(
    describeDaemonTarget({
      kind: "endpoint",
      host: "tcp://user:private@example.test:23456?password=secret",
    }),
  ).not.toMatch(/private|secret/);
  expect(
    describeDaemonTarget({ kind: "endpoint", host: "https://app.paseo.sh/#offer=private" }),
  ).not.toContain("private");
});

test("CLI selects an explicit password before a matching local credential and never sends the latter remotely", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-cli-credential-"));
  const previousPassword = process.env.PASEO_PASSWORD;
  delete process.env.PASEO_PASSWORD;
  try {
    const token = "a".repeat(43);
    await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6767" }));
    await writeFile(join(home, "local-credential"), token);
    expect(resolveDaemonCredential("tcp://localhost:6767", home)).toEqual({
      kind: "localCredential",
      token,
    });
    expect(resolveDaemonCredential("tcp://remote.example:6767", home)).toBeNull();
    expect(resolveDaemonCredential("tcp://localhost:6767?password=explicit", home)).toEqual({
      kind: "password",
      password: "explicit",
    });
  } finally {
    if (previousPassword === undefined) delete process.env.PASEO_PASSWORD;
    else process.env.PASEO_PASSWORD = previousPassword;
    await rm(home, { recursive: true, force: true });
  }
});
