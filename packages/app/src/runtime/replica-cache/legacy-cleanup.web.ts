const LEGACY_DATABASE_NAME = "paseo-replica-cache";

export function clearLegacyReplicaCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LEGACY_DATABASE_NAME);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Failed to delete legacy replica cache")),
    );
    request.addEventListener("blocked", () =>
      reject(new Error("Legacy replica cache deletion was blocked")),
    );
  });
}
