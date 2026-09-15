export async function waitForMetro(url, timeoutMs = 60_000) {
  const statusUrl = new URL("/status", url);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusUrl, { signal: AbortSignal.timeout(1_000) });
      const body = (await response.text()).trim();
      if (response.status === 200 && body === "packager-status:running") {
        return;
      }
    } catch {
      // Expo temporarily binds the port while checking availability, before Metro starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Metro at ${url}`);
}
