// Commands that stream until stopped (`paseo agent logs --follow`, `paseo agent
// attach`) stop on Ctrl+C, a termination signal, or when the program reading
// their output closes its end, as `| head` does. A closed reader shows up as
// EPIPE on the next write to stdout, so the command stops at its next line of
// output.
export function waitForStop(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      signal?.removeEventListener("abort", stop);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdout.off("error", stopOnClosedStdout);
      resolve();
    };
    const stopOnClosedStdout = (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") {
        stop();
      }
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdout.on("error", stopOnClosedStdout);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}
