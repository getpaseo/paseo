import { resolveCliVersion } from "./version.js";

const argv = process.argv.slice(2);
const versionOnly = argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v");
if (versionOnly) {
  process.stdout.write(`${resolveCliVersion()}\n`);
} else {
  const { runCli } = await import("./run.js");
  process.exitCode = await runCli(argv, {
    nodeArgv: [process.argv[0] ?? "node", process.argv[1] ?? "paseo"],
  });
}
