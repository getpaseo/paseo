#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { OpenRouterAgent } from "./agent.js";

// ACP uses ndJson over stdio. The agent writes outgoing JSON-RPC messages to
// stdout and reads incoming requests from stdin. ndJsonStream(writable,
// readable) takes the pair in that order.
const agentOut = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const agentIn = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(agentOut, agentIn);

new AgentSideConnection((conn) => new OpenRouterAgent(conn), stream);
