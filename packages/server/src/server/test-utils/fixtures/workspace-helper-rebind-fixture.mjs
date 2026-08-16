#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import readline from "node:readline";

const [helper, counterPath, ...args] = process.argv.slice(2);
if (!helper || !counterPath) throw new Error("helper and counter path are required");

if (args[0] !== "watch") {
  await forward();
} else {
  const launch = Number(await readFile(counterPath, "utf8").catch(() => "0")) + 1;
  await writeFile(counterPath, String(launch));
  if (launch !== 2) await forward();
  else await failSecondSubscription();
}

async function forward() {
  const child = spawn(process.execPath, [helper, ...args], { stdio: "inherit" });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.signal) process.kill(process.pid, exit.signal);
  process.exitCode = exit.code ?? 1;
}

async function failSecondSubscription() {
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, type: "ready" })}\n`);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let subscriptions = 0;
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.type === "subscribe") {
      subscriptions += 1;
      if (subscriptions === 2) {
        process.exitCode = 41;
        return;
      }
      process.stdout.write(
        `${JSON.stringify({ protocolVersion: 1, type: "subscribed", subscriptionId: message.id })}\n`,
      );
    } else if (message.type === "unsubscribe") {
      process.stdout.write(
        `${JSON.stringify({ protocolVersion: 1, type: "unsubscribed", subscriptionId: message.id })}\n`,
      );
    } else if (message.type === "close") return;
  }
}
