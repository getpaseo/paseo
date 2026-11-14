/** Largest file the app sends through `client.uploadFile`. */
export const FILE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

interface UploadLimitConfig {
  uploads?: { maxFileBytes?: number };
}

/** The daemon's advertised upload cap, falling back to the built-in default. */
export function resolveUploadMaxFileBytes(config: UploadLimitConfig | null | undefined): number {
  return config?.uploads?.maxFileBytes ?? FILE_UPLOAD_MAX_BYTES;
}

/** Words for the limit in user-facing errors, matching the "50MB" default style. */
export function formatUploadLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)}MB`;
}
