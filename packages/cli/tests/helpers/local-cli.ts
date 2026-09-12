import { $, ProcessPromise } from "zx";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const cliHome = mkdtempSync(join(tmpdir(), "paseo-test-cli-os-home-"));
process.once("exit", () => rmSync(cliHome, { recursive: true, force: true }));

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "dist", "index.js");

export function runLocalPaseo(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
): ProcessPromise {
  $.verbose = false;
  return $({
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
      ),
      ...env,
      HOME: cliHome,
      USERPROFILE: cliHome,
    },
  })`${process.execPath} ${CLI_ENTRY} ${args}`.nothrow();
}
