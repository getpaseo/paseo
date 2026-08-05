const DEFAULT_COLS = 120;

export interface NativeTerminalBenchmarkPayloadInput {
  startLine: number;
  lineCount: number;
  cols?: number;
}

function terminalLine(input: { index: number; cols: number }): string {
  const color = 31 + (input.index % 7);
  const label = `line ${input.index.toString().padStart(6, "0")} `;
  const body = "abcdefghijklmnopqrstuvwxyz0123456789 ".repeat(4);
  return `\x1b[${color}m${(label + body).slice(0, input.cols - 1)}\x1b[0m\r\n`;
}

export function createNativeTerminalBenchmarkPayload(
  input: NativeTerminalBenchmarkPayloadInput,
): string {
  const cols = input.cols ?? DEFAULT_COLS;
  let payload = "";
  for (let index = 0; index < input.lineCount; index += 1) {
    payload += terminalLine({ index: input.startLine + index, cols });
  }
  return payload;
}
