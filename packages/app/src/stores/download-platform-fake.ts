import type { CacheFile, DownloadPlatform, HttpDownloadRequest } from "./download-platform-types";

/**
 * In-memory DownloadPlatform for tests, colocated with the production module as
 * docs/testing.md asks. Records what a real device would have done to disk and to the
 * share sheet, so tests assert on behaviour rather than on mocked module internals.
 */
export interface FakeDownloadPlatform extends DownloadPlatform {
  readonly created: string[];
  readonly removed: string[];
  readonly shared: { uri: string; mimeType?: string }[];
  readonly httpRequests: HttpDownloadRequest[];
  readonly browserDeliveries: { url: string; fileName: string }[];
  bytesFor(fileName: string): Uint8Array;
  setSharingAvailable(available: boolean): void;
  failHttpWith(result: null): void;
}

export function createFakeDownloadPlatform(config: { isWeb?: boolean } = {}): FakeDownloadPlatform {
  const created: string[] = [];
  const removed: string[] = [];
  const shared: { uri: string; mimeType?: string }[] = [];
  const httpRequests: HttpDownloadRequest[] = [];
  const browserDeliveries: { url: string; fileName: string }[] = [];
  const contents = new Map<string, number[]>();
  let sharingAvailable = true;
  let httpResult: { uri: string } | null = { uri: "file:///cache/http-download" };

  return {
    isWeb: config.isWeb ?? false,
    created,
    removed,
    shared,
    httpRequests,
    browserDeliveries,
    bytesFor: (fileName) => Uint8Array.from(contents.get(fileName) ?? []),
    setSharingAvailable: (available) => {
      sharingAvailable = available;
    },
    failHttpWith: (result) => {
      httpResult = result;
    },

    createCacheFile(fileName: string): CacheFile {
      created.push(fileName);
      contents.set(fileName, []);
      return {
        uri: `file:///cache/${fileName}`,
        write: (bytes) => contents.get(fileName)?.push(...bytes),
        close: () => {},
        remove: () => {
          removed.push(fileName);
          contents.delete(fileName);
        },
      };
    },

    deliverToBrowser: (url, fileName) => {
      browserDeliveries.push({ url, fileName });
    },
    isSharingAvailable: async () => sharingAvailable,
    share: async (uri, shareOptions) => {
      shared.push({ uri, mimeType: shareOptions.mimeType });
    },
    downloadOverHttp: async (request) => {
      httpRequests.push(request);
      return httpResult;
    },
  };
}
