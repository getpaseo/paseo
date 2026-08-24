export function nativeTerminalPerformanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
