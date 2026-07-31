#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevRuntime } from "./dev-runtime-config.mjs";

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.stdout.write(JSON.stringify(await resolveDevRuntime()));
  } catch (error) {
    console.error(`[dev-runtime] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
