import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkLocalReleasePush } from "./local-release-inventory.mjs";
checkLocalReleasePush(readFileSync(0, "utf8"), {
  root: fileURLToPath(new URL("..", import.meta.url)),
});
