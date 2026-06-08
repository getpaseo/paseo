process.on("message", (message) => {
  if (!message || message.type !== "session.create") {
    if (message && message.requestId && process.send) {
      process.send({ type: "response", requestId: message.requestId, ok: true });
    }
    return;
  }

  process.send(
    {
      type: "response",
      requestId: message.requestId,
      ok: true,
      result: { requiredSampleRate: 16000 },
    },
    () => {
      const lock = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(lock, 0, 0, 500);
    },
  );
});

setInterval(() => undefined, 1000);
