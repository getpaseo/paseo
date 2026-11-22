import type { AcpContextWindowReader, AcpContextWindowSource } from "@getpaseo/plugin/server/acp";
import { conversationDbPath, readConversationDb } from "./conversation-db.js";

const maxRows = 32;
const maxBlobBytes = 256 * 1024;
const flushDelaysMs = [50, 150, 500];

function protobufField(bytes: Uint8Array, wanted: number): Uint8Array | number | undefined {
  let cursor = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; cursor < bytes.length && shift <= 63; shift += 7) {
      const byte = bytes[cursor++];
      if (shift === 63 && byte > 1) return undefined;
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    return undefined;
  };
  let result: Uint8Array | number | undefined;
  while (cursor < bytes.length) {
    const tag = varint();
    if (tag === undefined || tag <= 7 || tag > 0xffffffff) return undefined;
    const wire = tag & 7;
    if (wire === 0) {
      const number = varint();
      if (number === undefined) return undefined;
      if (tag === wanted) result = number;
    } else if (wire === 2) {
      const length = varint();
      if (length === undefined || length > bytes.length - cursor) return undefined;
      if (tag === wanted) result = bytes.subarray(cursor, cursor + length);
      cursor += length;
    } else if (wire === 1 || wire === 5) {
      cursor += wire === 1 ? 8 : 4;
      if (cursor > bytes.length) return undefined;
    } else {
      return undefined;
    }
  }
  return result;
}

function effectiveWindow(data: Uint8Array, model: Buffer): number | undefined {
  const chatStart = protobufField(data, 10); // [1]
  if (!(chatStart instanceof Uint8Array)) return undefined;
  // agy can report a newly selected model on load before generating with it. Check the
  // requested model in the generation row ([1, 19]) before using that row's window.
  const requestedModel = protobufField(chatStart, 154);
  if (!(requestedModel instanceof Uint8Array) || !model.equals(requestedModel)) return undefined;
  const metadata = protobufField(chatStart, 74); // [1, 9]
  if (!(metadata instanceof Uint8Array)) return undefined;
  const usage = protobufField(metadata, 82); // [1, 9, 10]
  if (!(usage instanceof Uint8Array)) return undefined;
  const limit = protobufField(usage, 32); // [1, 9, 10, 4]
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

export function createContextWindow(
  source: AcpContextWindowSource,
): AcpContextWindowReader | undefined {
  const file = conversationDbPath(source);
  if (!file) return undefined;
  let model: string | undefined;
  let modelBytes: Buffer | undefined;
  let initialized = false;
  let latestIdx = -1;
  let modelFloor = -1;
  let limit: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  source.signal.addEventListener("abort", stop, { once: true });

  function checkAfterFlush(attempt = 0): void {
    stop();
    if (source.signal.aborted || attempt === flushDelaysMs.length) return;
    timer = setTimeout(() => {
      source.refresh();
      checkAfterFlush(attempt + 1);
    }, flushDelaysMs[attempt]);
    timer.unref();
  }

  return (currentModel, reason) => {
    const changedModel = initialized && currentModel !== model;
    if (!initialized || changedModel) {
      model = currentModel;
      modelBytes = model === undefined ? undefined : Buffer.from(model);
    }
    if (changedModel) {
      stop();
      // Establish the old model's high-water mark in the same DB before accepting any new rows.
      modelFloor =
        readConversationDb(file, (db) => {
          const row = db.prepare("SELECT idx FROM gen_metadata ORDER BY idx DESC LIMIT 1").get();
          return typeof row?.idx === "number" ? row.idx : -1;
        }) ?? latestIdx;
      limit = undefined;
    } else if (modelBytes && (!initialized || reason !== "config")) {
      const expectedModel = modelBytes;
      readConversationDb(file, (db) => {
        const rows = db
          .prepare(`
          SELECT idx, CASE WHEN length(data) <= ? THEN data END AS data
          FROM gen_metadata WHERE idx > ? ORDER BY idx DESC LIMIT ?
        `)
          .iterate(maxBlobBytes, modelFloor, maxRows);
        for (const { idx, data } of rows) {
          if (typeof idx !== "number") continue;
          latestIdx = Math.max(latestIdx, idx);
          if (!(data instanceof Uint8Array)) continue;
          const value = effectiveWindow(data, expectedModel);
          if (value !== undefined) {
            limit = value;
            break;
          }
        }
      });
    }
    initialized = true;
    // agy can commit gen_metadata after both usage_update and the prompt response.
    if (reason === "usage" || reason === "settled") checkAfterFlush();
    return limit;
  };
}
