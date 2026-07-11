export function localizeDefaultTerminalName(name: string, terminalLabel: string): string {
  const match = name.match(/^Terminal (\d+)$/);
  if (match) {
    return `${terminalLabel} ${match[1]}`;
  }
  return name;
}
