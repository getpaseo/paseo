// Bundled into the terminal WebView as well as the app: keep this module dependency-free.
const DANGEROUS_NON_WINDOWS_PATH_CHARS = /[`$|&>~#!^*;<]/g;

function escapeNonWindowsPath(path: string): string {
  let nextPath = path;
  if (nextPath.includes("\\")) {
    nextPath = nextPath.replace(/\\/g, "\\\\");
  }

  nextPath = nextPath.replace(DANGEROUS_NON_WINDOWS_PATH_CHARS, "");

  if (nextPath.includes("'") && nextPath.includes('"')) {
    return `$'${nextPath.replace(/'/g, "\\'")}'`;
  }
  if (nextPath.includes("'")) {
    return `'${nextPath.replace(/'/g, "\\'")}'`;
  }
  return `'${nextPath}'`;
}

function escapeWindowsPath(path: string): string {
  if (!path.includes(" ")) {
    return path;
  }
  return `"${path}"`;
}

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** Quotes a path for the shell of the machine it belongs to, identified by the path's shape. */
export function prepareTerminalPath(path: string): string {
  if (WINDOWS_PATH.test(path)) {
    return escapeWindowsPath(path);
  }
  return escapeNonWindowsPath(path);
}

/**
 * Paths as terminal input: each quoted and followed by one space, so paths pasted
 * together or by consecutive gestures stay separate shell words. Never Enter.
 */
export function preparePathsForTerminalInput(paths: readonly string[]): string {
  return paths.map((path) => `${prepareTerminalPath(path)} `).join("");
}
