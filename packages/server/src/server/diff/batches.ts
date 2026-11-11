import { encodeDiffFrame, DiffOpcode, type DiffBody } from "@getpaseo/protocol/binary-frames/index";

export async function* packBodies(
  files: AsyncIterable<DiffBody> | Iterable<DiffBody>,
  revision: number,
): AsyncGenerator<DiffBody[]> {
  let batch: DiffBody[] = [];
  let size = 0;
  for await (const file of files) {
    const bytes = encodeDiffFrame({
      opcode: DiffOpcode.Bodies,
      slot: 0,
      revision,
      files: [file],
    }).length;
    if (batch.length && size + bytes > 256 * 1024) {
      yield batch;
      batch = [];
      size = 0;
    }
    batch.push(file);
    size += bytes;
    if (size >= 256 * 1024) {
      yield batch;
      batch = [];
      size = 0;
    }
  }
  if (batch.length) yield batch;
}
