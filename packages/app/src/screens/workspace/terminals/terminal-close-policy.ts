export function shouldConfirmTerminalClose(
  commandRunning: boolean | undefined,
  supportsCommandState: boolean,
): boolean {
  // Older daemons do not report command state, so preserve the previous safe behavior
  // until the host advertises the lifecycle field.
  return supportsCommandState ? commandRunning === true : true;
}
