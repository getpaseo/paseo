import type { ResolvedSharePayload, SharePayload } from "expo-sharing";

/** A file another app shared, copied to a temporary location this app may read and delete. */
export interface SharedFile {
  uri: string;
  name: string;
  mimeType: string;
}

/** What another app shared with Paseo, waiting for the user to choose where it goes. */
export interface IncomingShare {
  id: string;
  text: string;
  files: SharedFile[];
}

export interface IncomingShareRead {
  share: IncomingShare | null;
  /** Some shared files could not be copied, so the share is missing them. */
  filesUnreadable: boolean;
}

/** The expo-sharing calls the intake reads through. */
export interface ShareSource {
  getSharedPayloads(): SharePayload[];
  getResolvedSharedPayloadsAsync(): Promise<ResolvedSharePayload[]>;
  clearSharedPayloads(): void;
}

// The iOS share extension opens `<scheme>://expo-sharing`, and Android rewrites the share intent to
// the same URL so navigation libraries notice it.
const SHARE_INTAKE_URL = /^[a-z][a-z0-9+.-]*:\/\/expo-sharing(?:[/?#]|$)/i;

export function isShareIntakeUrl(url: string): boolean {
  return SHARE_INTAKE_URL.test(url);
}

/**
 * The router must not treat the share URL as a route. A cold start opens the root route, which
 * restores the last workspace; a warm start stays where the user was.
 */
export function redirectShareIntakePath(input: { path: string; initial: boolean }): string | null {
  if (!isShareIntakeUrl(input.path)) return input.path;
  return input.initial ? "/" : null;
}

const FILE_SHARE_TYPES: ReadonlySet<string> = new Set(["file", "image", "video", "audio"]);

/** Android reports a shared text file (.md, .csv) as a "text" payload whose value is its URI. */
export function payloadCarriesFile(payload: SharePayload): boolean {
  return FILE_SHARE_TYPES.has(payload.shareType) || /^(content|file):/i.test(payload.value);
}

/** The shared text and links, in the order the sending app listed them. */
export function sharedTextFromPayloads(payloads: readonly SharePayload[]): string {
  const values = new Set<string>();
  for (const payload of payloads) {
    if (payloadCarriesFile(payload)) continue;
    const value = payload.value.trim();
    if (value) values.add(value);
  }
  return [...values].join("\n");
}

/** Android resolves copies to `file:/data/...` (java.io.File#toURI); expo-file-system wants `file:///`. */
export function normalizeLocalFileUri(uri: string): string {
  return uri.replace(/^file:\/(?!\/)/i, "file:///");
}

function fileNameFromUri(uri: string): string {
  const segment = uri.split(/[?#]/, 1)[0]?.split("/").pop() ?? "";
  try {
    return decodeURIComponent(segment) || "file";
  } catch {
    return segment || "file";
  }
}

export function sharedFilesFromResolved(payloads: readonly ResolvedSharePayload[]): SharedFile[] {
  const files: SharedFile[] = [];
  for (const payload of payloads) {
    // A resolved link points at the web page, not at a local copy.
    if (payload.shareType === "url" || !payload.contentUri) continue;
    const uri = normalizeLocalFileUri(payload.contentUri);
    files.push({
      uri,
      name: payload.originalName?.trim() || fileNameFromUri(uri),
      mimeType: payload.contentMimeType || payload.mimeType || "application/octet-stream",
    });
  }
  return files;
}

/**
 * Reads and clears whatever another app shared. Files are only resolved when the share has some:
 * resolving a link costs a network request, and one failed request fails the whole resolution.
 */
export async function readIncomingShare(
  source: ShareSource,
  createId: () => string,
): Promise<IncomingShareRead> {
  try {
    const payloads = source.getSharedPayloads();
    const text = sharedTextFromPayloads(payloads);
    const expectedFileCount = payloads.filter(payloadCarriesFile).length;
    let files: SharedFile[] = [];
    if (expectedFileCount > 0) {
      try {
        files = sharedFilesFromResolved(await source.getResolvedSharedPayloadsAsync());
      } catch (error) {
        console.warn("[ShareIntake] Failed to read shared files", error);
      }
    }
    const share = text || files.length > 0 ? { id: createId(), text, files } : null;
    return { share, filesUnreadable: files.length < expectedFileCount };
  } finally {
    source.clearSharedPayloads();
  }
}

/** One line naming what was shared, for the target picker's subtitle. */
export function describeIncomingShare(share: IncomingShare): string {
  if (share.files.length > 0) return share.files.map((file) => file.name).join(", ");
  return share.text.split("\n", 1)[0] ?? "";
}

/**
 * Runs `task` once per burst of requests. A share wakes the app through both the URL event and the
 * foreground event; reading twice at once would offer the same share twice. A request that lands
 * mid-run triggers one more run afterwards, so a share that arrives during a read is not missed.
 */
export function coalesceRuns(task: () => Promise<void>): () => Promise<void> {
  let running = false;
  let requestedAgain = false;
  return async () => {
    if (running) {
      requestedAgain = true;
      return;
    }
    running = true;
    try {
      do {
        requestedAgain = false;
        await task();
      } while (requestedAgain);
    } finally {
      running = false;
    }
  };
}
