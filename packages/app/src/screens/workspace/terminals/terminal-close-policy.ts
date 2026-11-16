export function shouldConfirmTerminalClose(commandRunning: boolean | undefined): boolean {
  // Older daemons do not send commandRunning, so keep the existing safe behavior until they
  // reconnect with a daemon that can observe shell command lifecycle.
  return commandRunning !== false;
}
