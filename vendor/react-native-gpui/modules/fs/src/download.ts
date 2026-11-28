/**
 * `download`: an HTTP response streamed into a file.
 *
 * The body goes to `<path>.part` as it arrives and is renamed onto `path` once it
 * is complete, so `path` never holds half a file. The partial file is removed when
 * the request fails or is aborted.
 */

import NativeFs from './NativeFs';
import { nodeError, toPath, withContext, type NodeError } from './shared';

export interface DownloadOptions {
  /** `GET` unless set. No request body is sent. */
  method?: string;
  headers?: Record<string, string>;
  /** Called while the body arrives; `total` is `-1` when the server did not say. */
  onProgress?: (received: number, total: number) => void;
  /** Aborting rejects with an `AbortError` and removes the partial file. */
  signal?: AbortSignal;
}

export interface DownloadResult {
  status: number;
  /** Response headers, lower-cased; repeated headers are joined with `, `. */
  headers: Record<string, string>;
  /** The size of the file that was written. */
  bytes: number;
}

/** What a non-2xx response rejects with. */
export interface DownloadHttpError extends NodeError {
  status: number;
  headers: Record<string, string>;
  /** The first part of the response body. */
  body: string;
}

let nextId = 1;

function abortError(): NodeError {
  const error = nodeError('ABORT_ERR', 'The download was aborted');
  error.name = 'AbortError';
  return error;
}

function toRecord(list: Array<{ name: string; value: string }>) {
  const record: Record<string, string> = {};
  for (const { name, value } of list) {
    record[name] = value;
  }
  return record;
}

export async function download(
  url: string,
  path: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const { signal, onProgress } = options;
  if (signal?.aborted) {
    throw abortError();
  }
  const target = toPath(path);
  const id = nextId++;
  const subscription = onProgress
    ? NativeFs.onDownloadProgress(event => {
        if (event.id === id) {
          onProgress(event.received, event.total);
        }
      })
    : null;
  const onAbort = () => {
    NativeFs.cancelDownload(id);
  };
  signal?.addEventListener('abort', onAbort);

  try {
    const result = await NativeFs.download(url, target, {
      id,
      method: options.method ?? 'GET',
      headers: Object.entries(options.headers ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
    });
    const headers = toRecord(result.headers);
    if (result.status < 200 || result.status >= 300) {
      const error = nodeError(
        'ERR_HTTP_STATUS',
        `HTTP ${result.status} downloading ${url}`,
      ) as DownloadHttpError;
      error.status = result.status;
      error.headers = headers;
      error.body = result.body ?? '';
      throw error;
    }
    return { status: result.status, headers, bytes: result.bytes };
  } catch (error) {
    if (signal?.aborted) {
      throw abortError();
    }
    if ((error as NodeError)?.code === 'ABORT_ERR') {
      throw abortError();
    }
    throw withContext(error, 'download', target);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    subscription?.remove();
  }
}
