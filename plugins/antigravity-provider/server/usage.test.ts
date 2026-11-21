import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Usage } from "./usage.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

it("discovers the resolved account and maps the CLI's quota buckets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-usage-"));
  directories.push(directory);
  const cli = path.join(directory, "cli.cjs");
  await writeFile(
    cli,
    `
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['-p', '/usage', '--output-format', 'json'])) process.exit(2);
    console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: [
        { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.25, reset_time: '2026-11-19T14:25:08Z' },
        { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.7 },
        { id: 'disabled', name: 'Weekly', window: 'weekly', disabled: true, remaining_fraction: 1 }
      ] }
    ] } } }));
  `,
  );
  const usage = new Usage();
  const launch = {
    command: process.execPath,
    args: [cli, "acp", "--disable-telemetry"],
    env: { HOME: directory },
  };
  const source = usage.registration();
  const accounts = await source.discover({ kind: "global", launch });
  expect(accounts).toHaveLength(1);
  expect(
    await source.discover({
      kind: "session",
      provider: "antigravity",
      env: { HOME: directory },
      launch,
    }),
  ).toEqual(accounts);
  expect(
    await source.discover({
      kind: "session",
      provider: "antigravity",
      env: { HOME: `${directory}-other` },
    }),
  ).toEqual([]);
  expect(
    await source.discover({ kind: "session", provider: "codex", env: { HOME: directory } }),
  ).toEqual([]);
  const otherLaunch = { ...launch, env: { HOME: `${directory}-other` } };
  const other = await source.discover({
    kind: "session",
    provider: "antigravity",
    env: otherLaunch.env,
    launch: otherLaunch,
  });
  expect(other[0]?.key).not.toBe(accounts[0]?.key);
  expect(other[0]?.input).not.toEqual(accounts[0]?.input);
  expect(await source.fetch(accounts[0]!.input)).toMatchObject({
    status: "available",
    windows: [
      {
        id: "gemini-5h",
        label: "Gemini · 5h",
        shortLabel: "5h",
        durationSeconds: 18_000,
        usedPct: 75,
        remainingPct: 25,
        resetsAt: "2026-11-19T14:25:08Z",
      },
      { id: "gemini-weekly", shortLabel: "wk", usedPct: expect.closeTo(30), summary: true },
      {
        id: "disabled",
        label: "Gemini · Weekly · Disabled",
        shortLabel: "wk",
        usedPct: null,
        remainingPct: null,
      },
    ],
  });
});

it("uses compact group and period shorthands when multiple groups are reported", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-usage-"));
  directories.push(directory);
  const cli = path.join(directory, "cli.cjs");
  await writeFile(
    cli,
    `
    console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: [
        { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9 },
        { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.8 }
      ] },
      { name: 'Claude and GPT models', buckets: [
        { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1 }
      ] }
    ] } } }));
  `,
  );
  const launch = { command: process.execPath, args: [cli, "acp"], env: { HOME: directory } };
  const source = new Usage().registration();
  const [account] = await source.discover({ kind: "global", launch });
  expect(await source.fetch(account!.input)).toMatchObject({
    status: "available",
    windows: [
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly",
        shortLabel: "Gemini wk",
        durationSeconds: 604_800,
      },
      { id: "gemini-5h", label: "Gemini · 5h", shortLabel: "Gemini 5h" },
      { id: "3p-weekly", label: "Claude and GPT · Weekly", shortLabel: "Claude and GPT wk" },
    ],
  });
});

it("surfaces CLI errors instead of reporting a successful quota", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-usage-"));
  directories.push(directory);
  const cli = path.join(directory, "cli.cjs");
  await writeFile(
    cli,
    `console.log(JSON.stringify({ status: 'ERROR', error: 'Authentication required' }));`,
  );
  const usage = new Usage();
  const launch = { command: process.execPath, args: [cli, "acp"], env: { HOME: directory } };
  const source = usage.registration();
  const [account] = await source.discover({ kind: "global", launch });
  await expect(source.fetch(account!.input)).rejects.toThrow("Authentication required");
});

it("reports a failed CLI without exposing its stderr", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-usage-"));
  directories.push(directory);
  const cli = path.join(directory, "cli.cjs");
  await writeFile(cli, `process.stderr.write('authentication token=private'); process.exit(1);`);
  const launch = { command: process.execPath, args: [cli, "acp"], env: { HOME: directory } };
  const source = new Usage().registration();
  const [account] = await source.discover({ kind: "global", launch });
  await expect(source.fetch(account!.input)).rejects.toThrow(
    "Antigravity usage command failed or timed out. Check that agy is signed in.",
  );
});
