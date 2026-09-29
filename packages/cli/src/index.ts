import { runCli } from "./run.js";

const exitCode = await runCli(process.argv.slice(2), {
  nodeArgv: [process.argv[0] ?? "node", process.argv[1] ?? "pandaos"],
});
process.exitCode = exitCode;
