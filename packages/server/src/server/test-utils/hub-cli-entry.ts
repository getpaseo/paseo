import { createHubCommand } from "../../../../cli/src/commands/hub/index.js";

const argv = [process.argv[0] ?? "node", process.argv[1] ?? "paseo", ...process.argv.slice(3)];
await createHubCommand().parseAsync(argv, { from: "node" });
