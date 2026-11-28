/**
 * `upload`: a file, or a range of one, streamed as an HTTP request body.
 *
 * The native side reads the file in small blocks while the connection takes
 * them, so nothing larger than a block is ever held in memory.
 */

import NativeFs from './NativeFs';
import { nodeError, toPath, withContext, type NodeError } from './shared';

export interface UploadOptions {
  /** `PUT` unless set. */
  method?: string;
  headers?: Record<string, string>;
  /** Where in the file the body starts. Zero unless set. */
  offset?: number;
  /** How many bytes to send. Everything from `offset` unless set. */
  length?: number;
  /** Called while the body is sent. */
  onProgress?: (sent: number, total: number) => void;
  /** Aborting rejects with an `AbortError`. */
  signal?: AbortSignal;
}

export interface UploadResult {
  status: number;
  /** Response headers, lower-cased; repeated headers are joined with `, `. */
  headers: Record<string, string>;
  /** The first part of the response body. */
  body: string;
}

let nextId = 1;

function abortError(): NodeError {
  const error = nodeError('ABORT_ERR', 'The upload was aborted');
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

export async function upload(
  url: string,
  path: string,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const { signal, onProgress } = options;
  if (signal?.aborted) {
    throw abortError();
  }
  const source = toPath(path);
  const id = nextId++;
  const subscription = onProgress
    ? NativeFs.onUploadProgress(event => {
        if (event.id === id) {
          onProgress(event.sent, event.total);
        }
      })
    : null;
  const onAbort = () => {
    NativeFs.cancelUpload(id);
  };
  signal?.addEventListener('abort', onAbort);

  try {
    const result = await NativeFs.upload(url, source, {
      id,
      method: options.method ?? 'PUT',
      headers: Object.entries(options.headers ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
      offset: options.offset ?? 0,
      length: options.length ?? -1,
    });
    return {
      status: result.status,
      headers: toRecord(result.headers),
      body: result.body,
    };
  } catch (error) {
    if (signal?.aborted || (error as NodeError)?.code === 'ABORT_ERR') {
      throw abortError();
    }
    throw withContext(error, 'upload', source);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    subscription?.remove();
  }
}
