#!/usr/bin/env node
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
}

const socketPath = path.join(
  os.tmpdir(),
  `codex-ipc-repro-${process.pid}-${Date.now()}.sock`,
);

safeUnlink(socketPath);

const server = net.createServer();

server.on("error", (error) => {
  const code = error && error.code ? error.code : "UNKNOWN";
  const message = error && error.message ? error.message : String(error);
  process.stdout.write(`ERROR ${code} ${message}\n`);
  safeUnlink(socketPath);
  process.exitCode = 1;
});

server.listen(socketPath, () => {
  process.stdout.write(`LISTENING ${socketPath}\n`);
  server.close(() => {
    safeUnlink(socketPath);
  });
});

