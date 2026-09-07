export function logHook(hook: string, data: unknown): void {
  const entry = { hook, timestamp: new Date().toISOString(), data };
  const line = JSON.stringify(entry, (key, value: unknown) => {
    if (key === "env" && value !== null && typeof value === "object") {
      const redacted: Record<string, string> = {};
      for (const name of Object.keys(value)) {
        redacted[name] = "[redacted]";
      }
      return redacted;
    }
    return value;
  });
  console.log(line);
}
