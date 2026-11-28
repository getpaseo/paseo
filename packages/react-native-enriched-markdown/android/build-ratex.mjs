import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(root, "vendor/ratex");
const output = process.argv[2];
const abis = process.argv.slice(3);
const supported = new Set(["armeabi-v7a", "arm64-v8a", "x86", "x86_64"]);
if (!output || !abis.length || abis.some((abi) => !supported.has(abi))) throw new Error(`Invalid RaTeX output or ABIs: ${abis.join(", ")}`);
mkdirSync(output, { recursive: true });
const args = ["ndk", ...abis.flatMap((abi) => ["--target", abi]), "--output-dir", output,
  "build", "--release", "--locked", "-p", "ratex-ffi"];
const cargoBin = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo"), "bin");
const build = spawnSync("cargo", args, { cwd: source, stdio: "inherit",
  env: { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH ?? ""}`,
    CARGO_TARGET_DIR: path.join(root, "build/ratex-target") } });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
