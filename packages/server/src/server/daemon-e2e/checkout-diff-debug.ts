#!/usr/bin/env npx tsx
/**
 * Ad-hoc checkout diff debugger.
 *
 * Usage:
 *   npx tsx packages/server/src/server/daemon-e2e/checkout-diff-debug.ts
 *   npx tsx packages/server/src/server/daemon-e2e/checkout-diff-debug.ts --agent <agentId>
 *   npx tsx packages/server/src/server/daemon-e2e/checkout-diff-debug.ts --cwd <path>
 *   npx tsx packages/server/src/server/daemon-e2e/checkout-diff-debug.ts --limit 3
 *
 * Optional env:
 *   PASEO_LISTEN=127.0.0.1:6767
 */

import os from "node:os";
import { DaemonClient } from "../../client/daemon-client.js";

type CliArgs = {
  agentId?: string;
  cwd?: string;
  limit: number;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { limit: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--agent") {
      const value = argv[i + 1];
      if (value) {
        args.agentId = value;
        i += 1;
      }
      continue;
    }
    if (token === "--cwd") {
      const value = argv[i + 1];
      if (value) {
        args.cwd = value;
        i += 1;
      }
      continue;
    }
    if (token === "--limit") {
      const value = Number.parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isNaN(value) && value > 0) {
        args.limit = value;
        i += 1;
      }
    }
  }
  return args;
}

function fmtMs(ms: number): string {
  return `${ms.toLocaleString()}ms`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const listen = process.env.PASEO_LISTEN ?? "127.0.0.1:6767";
  const url = `ws://${listen}/ws`;
  const home = process.env.PASEO_HOME ?? `${os.homedir()}/.paseo`;

  console.log("Checkout Diff Debugger");
  console.log(`daemon=${url}`);
  console.log(`PASEO_HOME=${home}`);
  console.log(
    `filters agent=${args.agentId ?? "-"} cwd=${args.cwd ?? "-"} limit=${args.limit}`
  );
  console.log("");

  const client = new DaemonClient({
    url,
    reconnect: { enabled: false },
  });

  client.on("checkout_status_response", (message) => {
    if (message.type !== "checkout_status_response") return;
    const payload = message.payload;
    console.log(
      `[raw] checkout_status_response requestId=${payload.requestId} cwd=${payload.cwd} isGit=${payload.isGit}`
    );
  });

  client.on("checkout_diff_response", (message) => {
    if (message.type !== "checkout_diff_response") return;
    const payload = message.payload;
    console.log(
      `[raw] checkout_diff_response requestId=${payload.requestId} cwd=${payload.cwd} files=${payload.files.length} error=${payload.error ? "yes" : "no"}`
    );
  });

  client.on("rpc_error", (message) => {
    if (message.type !== "rpc_error") return;
    const payload = message.payload;
    console.log(
      `[raw] rpc_error requestId=${payload.requestId} requestType=${payload.requestType} code=${payload.code ?? "none"}`
    );
  });

  try {
    await client.connect();
    const ping = await client.ping({ timeoutMs: 3000 });
    console.log(`ping=${fmtMs(ping.rttMs)}`);

    const snapshots = await client.fetchAgents({ filter: { labels: { ui: "true" } } });
    const candidates = snapshots
      .filter((snapshot) => !args.agentId || snapshot.id === args.agentId)
      .map((snapshot) => ({
        id: snapshot.id,
        title: snapshot.title ?? "(untitled)",
        cwd: snapshot.cwd,
        updatedAt: snapshot.updatedAt,
      }))
      .filter((item) => !args.cwd || item.cwd === args.cwd)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    const targets = (args.cwd
      ? [{ id: "(manual)", title: "(manual)", cwd: args.cwd, updatedAt: new Date().toISOString() }]
      : candidates
    )
      .slice(0, args.limit)
      .filter((item, index, list) => list.findIndex((v) => v.cwd === item.cwd) === index);

    if (targets.length === 0) {
      console.log("No matching agents/cwds found.");
      return;
    }

    console.log(`Testing ${targets.length} cwd target(s)\n`);

    for (const target of targets) {
      console.log(`--- ${target.cwd}`);
      console.log(`agent=${target.id} title=${target.title}`);

      const statusStart = Date.now();
      let statusPayload: Awaited<ReturnType<typeof client.getCheckoutStatus>>;
      try {
        statusPayload = await client.getCheckoutStatus(target.cwd);
        console.log(
          `status: ok ${fmtMs(Date.now() - statusStart)} isGit=${statusPayload.isGit} branch=${statusPayload.currentBranch ?? "-"} dirty=${statusPayload.isDirty ?? "-"} baseRef=${statusPayload.baseRef ?? "-"}`
        );
        if (statusPayload.error) {
          console.log(`status.error=${statusPayload.error.message}`);
        }
      } catch (error) {
        console.log(`status: FAIL ${fmtMs(Date.now() - statusStart)} ${String(error)}`);
        console.log("");
        continue;
      }

      if (!statusPayload.isGit) {
        console.log("diff: skipped (not a git repo)\n");
        continue;
      }

      const compareMode = statusPayload.isDirty ? "uncommitted" : "base";
      const diffStart = Date.now();
      try {
        const diff = await client.getCheckoutDiff(target.cwd, {
          mode: compareMode,
          baseRef: statusPayload.baseRef ?? undefined,
        });
        const diffDuration = Date.now() - diffStart;
        console.log(
          `diff: ok ${fmtMs(diffDuration)} mode=${compareMode} files=${diff.files.length} error=${diff.error ? "yes" : "no"}`
        );
        if (diff.error) {
          console.log(`diff.error=${diff.error.message}`);
        }
      } catch (error) {
        console.log(`diff: FAIL ${fmtMs(Date.now() - diffStart)} ${String(error)}`);
      }
      console.log("");
    }
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

