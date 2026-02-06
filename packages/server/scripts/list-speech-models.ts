import { listLocalSpeechModels } from "../src/server/speech/providers/local/models.js";

const models = listLocalSpeechModels()
  .slice()
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

for (const m of models) {
  // eslint-disable-next-line no-console
  console.log(`${m.kind}\t${m.id}\t${m.description}`);
}
