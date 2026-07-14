export interface TerminalViewportSize {
  rows: number;
  cols: number;
}

function cacheKey(input: { serverId: string; cwd: string }): string {
  // JSON-encode the pair so a `:` inside serverId or cwd (e.g. a Windows `C:\` path) can't
  // make two different (serverId, cwd) pairs collide onto the same key.
  return JSON.stringify([input.serverId, input.cwd]);
}

const sizeByWorkspace = new Map<string, TerminalViewportSize>();
let mostRecentSize: TerminalViewportSize | null = null;

/**
 * Remember the latest measured terminal viewport size for a workspace. Every terminal in a
 * workspace renders into the same pane, so this is the best estimate of the size a *new*
 * terminal in that workspace will render at — used to seed the PTY at creation time instead
 * of the daemon's 80x24 default (which otherwise shows briefly, or sticks, until the first
 * resize lands).
 */
export function rememberTerminalViewportSize(input: {
  serverId: string;
  cwd: string;
  size: TerminalViewportSize;
}): void {
  const size: TerminalViewportSize = { rows: input.size.rows, cols: input.size.cols };
  sizeByWorkspace.set(cacheKey(input), size);
  mostRecentSize = size;
}

/**
 * Best estimate of the viewport size a new terminal in this workspace will render at:
 * the last measured size for the same workspace, else the most recently measured size
 * anywhere (panes are usually the same size across workspaces on one device), else null
 * when nothing has been measured yet this session — in which case the daemon keeps its
 * 80x24 default and the first resize corrects it as before.
 */
export function estimateTerminalViewportSize(input: {
  serverId: string;
  cwd: string;
}): TerminalViewportSize | null {
  return sizeByWorkspace.get(cacheKey(input)) ?? mostRecentSize;
}

/** Test-only: clear all remembered sizes so cases don't leak into each other. */
export function resetTerminalViewportSizeCacheForTests(): void {
  sizeByWorkspace.clear();
  mostRecentSize = null;
}
