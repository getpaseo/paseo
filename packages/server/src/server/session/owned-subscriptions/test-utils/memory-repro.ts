import { SessionDelivery } from "../index.js";

const cycles = Number(process.argv[2]);
const count = 4096;
for (let index = 0; index <= cycles; index++) {
  const delivery = new SessionDelivery(() => {});
  const source = {};
  delivery.attach(source, true);
  delivery.forSource(source, () => {});
  await delivery.request(source, { type: "ping", requestId: String(index) }, async () => {});
  await delivery.close();
}

if (!global.gc) throw new Error("Run with --expose-gc");
global.gc();
const before = process.memoryUsage().heapUsed;
const held = Array.from({ length: count }, () => new Promise<void>(() => {}));
global.gc();
const retainedBytes = process.memoryUsage().heapUsed - before;
process.stdout.write(String(retainedBytes));
if (held.length !== count) throw new Error("Promise allocation failed");
