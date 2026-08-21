import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { buildConfigJsonSchema } from "../src/server/persisted-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function main() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const outPath = path.join(repoRoot, "packages/website/public/schemas/paseo.config.v1.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  fs.writeFileSync(outPath, JSON.stringify(buildConfigJsonSchema(), null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${outPath}\n`);
}

main();
