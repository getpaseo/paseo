// A limit of the daemon's own terminal model, kept in its own dependency-free
// module on purpose. The restore policy needs the ceiling, and policy code runs in
// the daemon parent, where the terminal implementation (node-pty,
// @xterm/headless) must stay behind the worker.
export const TERMINAL_MODEL_SCROLLBACK_LINES = 1000;
