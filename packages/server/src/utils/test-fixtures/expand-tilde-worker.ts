import { parentPort, workerData } from "node:worker_threads";
import { expandTilde } from "../path.js";

const port = parentPort!;
const input: string = workerData;
port.postMessage(expandTilde(input));
