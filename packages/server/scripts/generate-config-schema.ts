import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { z } from "zod";
import { PersistedConfigSchema } from "../src/server/persisted-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function main() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const outPath = path.join(repoRoot, "packages/website/public/schemas/paseo.config.v1.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const schema = {
    ...z.toJSONSchema(PersistedConfigSchema, { target: "draft-7" }),
    title: "PaseoConfigV1",
  };

  fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${outPath}\n`);
}

main();
