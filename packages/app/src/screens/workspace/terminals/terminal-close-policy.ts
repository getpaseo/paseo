export function shouldConfirmTerminalClose(commandRunning: boolean | undefined): boolean {
  return commandRunning === true;
}
