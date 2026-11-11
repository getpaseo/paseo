function ignoreClosedConsole(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") {
    throw error;
  }
}

/** Keep desktop logging independent of the program that launched its console. */
export function protectConsoleStreams(): void {
  process.stdout.on("error", ignoreClosedConsole);
  process.stderr.on("error", ignoreClosedConsole);
}
