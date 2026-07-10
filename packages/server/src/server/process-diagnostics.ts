export interface ProcessMemoryDiagnostics {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface ProcessDiagnostics {
  pid: number;
  ppid: number;
  uptimeSeconds: number;
  memory: ProcessMemoryDiagnostics;
}

export function getProcessMemoryDiagnostics(): ProcessMemoryDiagnostics {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

export function getProcessUptimeSeconds(): number {
  return Math.round(process.uptime() * 1000) / 1000;
}

export function getProcessDiagnostics(): ProcessDiagnostics {
  return {
    pid: process.pid,
    ppid: process.ppid,
    uptimeSeconds: getProcessUptimeSeconds(),
    memory: getProcessMemoryDiagnostics(),
  };
}
