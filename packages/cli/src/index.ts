import { createCli } from "./cli.js";
import { isPathLikeArg, openDesktopWithProject } from "./commands/open.js";

const program = createCli();

const firstArg = process.argv[2];
if (firstArg && isPathLikeArg(firstArg)) {
  await openDesktopWithProject(firstArg);
} else {
  if (process.argv.length <= 2) {
    process.argv.push("onboard");
  }
  program.parse(process.argv, { from: "node" });
}
