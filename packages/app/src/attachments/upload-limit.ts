/** Largest file the app sends through `client.uploadFile`. */
export const FILE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

interface UploadLimitConfig {
  uploads?: { maxFileBytes?: number };
}

/** The daemon's advertised upload cap, falling back to the built-in default. */
export function resolveUploadMaxFileBytes(config: UploadLimitConfig | null | undefined): number {
  return config?.uploads?.maxFileBytes ?? FILE_UPLOAD_MAX_BYTES;
}
