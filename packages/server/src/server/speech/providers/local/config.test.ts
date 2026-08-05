import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveLocalSpeechConfig } from "./config.js";
import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";

const PASEO_HOME = "/tmp/paseo-home";
// Matches expandTilde in utils/path.ts, which prefers $HOME over os.homedir().
const HOME_DIR = process.env.HOME || os.homedir();

const LOCAL_PROVIDERS: RequestedSpeechProviders = {
  dictationStt: { provider: "local", explicit: true },
  voiceTurnDetection: { provider: "local", explicit: true },
  voiceStt: { provider: "local", explicit: true },
  voiceTts: { provider: "local", explicit: true },
};

function resolveModelsDir(params: {
  env?: NodeJS.ProcessEnv;
  persisted?: PersistedConfig;
}): string | undefined {
  return resolveLocalSpeechConfig({
    paseoHome: PASEO_HOME,
    env: params.env ?? {},
    persisted: params.persisted ?? {},
    providers: LOCAL_PROVIDERS,
  }).local?.modelsDir;
}

describe("resolveLocalSpeechConfig modelsDir", () => {
  it("expands ~ from persisted providers.local.modelsDir", () => {
    expect(
      resolveModelsDir({
        persisted: { providers: { local: { modelsDir: "~/speech-models" } } },
      }),
    ).toBe(path.resolve(HOME_DIR, "speech-models"));
  });

  it("expands ~ from PASEO_LOCAL_MODELS_DIR", () => {
    expect(resolveModelsDir({ env: { PASEO_LOCAL_MODELS_DIR: "~/env-speech-models" } })).toBe(
      path.resolve(HOME_DIR, "env-speech-models"),
    );
  });

  it("expands a bare ~", () => {
    expect(resolveModelsDir({ persisted: { providers: { local: { modelsDir: "~" } } } })).toBe(
      path.resolve(HOME_DIR),
    );
  });

  it("anchors a relative configured path to paseoHome", () => {
    expect(
      resolveModelsDir({ persisted: { providers: { local: { modelsDir: "models/speech" } } } }),
    ).toBe(path.join(PASEO_HOME, "models", "speech"));
  });

  // Verbatim, not `path.resolve`d: on Windows that would anchor a POSIX-style
  // path onto the current drive.
  it("leaves an absolute configured path alone", () => {
    expect(
      resolveModelsDir({ persisted: { providers: { local: { modelsDir: "/opt/speech" } } } }),
    ).toBe("/opt/speech");
  });

  it("defaults under paseoHome", () => {
    expect(resolveModelsDir({})).toBe(path.join(PASEO_HOME, "models", "local-speech"));
  });
});
