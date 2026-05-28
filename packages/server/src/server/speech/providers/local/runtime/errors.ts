import type { LocalSpeechRuntimePackageId } from "./package-specs.js";

export interface LocalSpeechRuntimeStatus {
  runtimeDir: string;
  missingPackageIds: LocalSpeechRuntimePackageId[];
}

export class LocalSpeechRuntimeUnavailableError extends Error {
  public readonly code = "local_speech_runtime_not_installed";
  public readonly runtimeDir: string;
  public readonly missingPackageIds: LocalSpeechRuntimePackageId[];

  constructor(status: LocalSpeechRuntimeStatus) {
    const missing = status.missingPackageIds.join(", ");
    super(`Local voice runtime is downloading / not installed (${missing}).`);
    this.name = "LocalSpeechRuntimeUnavailableError";
    this.runtimeDir = status.runtimeDir;
    this.missingPackageIds = [...status.missingPackageIds];
  }
}
