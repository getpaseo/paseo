/**
 * Accelerator notation for a custom menu.
 *
 * A native menu draws the shortcut using the platform's own symbols, and an
 * in-window menu that spelled `CmdOrCtrl+Shift+K` would be the one place the
 * custom menu visibly disagreed with the OS. This is the single intentional
 * per-platform difference in the component, so it is isolated here and kept a
 * pure function of the spec and a host name.
 *
 * @format
 */

const MAC_SYMBOLS: Record<string, string> = {
  cmdorctrl: '\u2318',
  commandorcontrol: '\u2318',
  cmdorcontrol: '\u2318',
  controllorcmd: '\u2318',
  command: '\u2318',
  cmd: '\u2318',
  super: '\u2318',
  meta: '\u2318',
  control: '\u2303',
  ctrl: '\u2303',
  alt: '\u2325',
  option: '\u2325',
  shift: '\u21e7',
  altgr: '\u2325',
};

const OTHER_MODIFIERS: Record<string, string> = {
  cmdorctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorcontrol: 'Ctrl',
  controllorcmd: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  altgr: 'AltGr',
};

const MAC_KEYS: Record<string, string> = {
  enter: '\u21a9',
  return: '\u21a9',
  escape: 'Esc',
  esc: 'Esc',
  tab: '\u21e5',
  space: 'Space',
  spacebar: 'Space',
  backspace: '\u232b',
  delete: '\u2326',
  del: '\u2326',
  up: '\u2191',
  arrowup: '\u2191',
  down: '\u2193',
  arrowdown: '\u2193',
  left: '\u2190',
  arrowleft: '\u2190',
  right: '\u2192',
  arrowright: '\u2192',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  plus: '+',
  minus: '-',
  comma: ',',
  period: '.',
};

const OTHER_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  escape: 'Esc',
  esc: 'Esc',
  tab: 'Tab',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Del',
  del: 'Del',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  plus: '+',
  minus: '-',
  comma: ',',
  period: '.',
};

function keyLabel(token: string, isMac: boolean): string {
  const lower = token.toLowerCase();
  const table = isMac ? MAC_KEYS : OTHER_KEYS;
  if (table[lower] != null) {
    return table[lower];
  }
  // Function keys and single characters are spelled the same everywhere; a
  // single character keeps its case, so `Cmd+Z` does not become `z`.
  if (/^f\d{1,2}$/.test(lower)) {
    return lower.toUpperCase();
  }
  return token;
}

/**
 * "CmdOrCtrl+Shift+K" becomes "⌘⇧K" on macOS and "Ctrl+Shift+K" elsewhere. An
 * empty or malformed spec returns an empty string, which the row treats as "no
 * accelerator" rather than as an error: a menu must still open if one item's
 * shortcut is written oddly.
 */
export function formatAccelerator(
  spec: string | undefined,
  platform: string,
): string {
  if (spec == null) {
    return '';
  }
  const trimmed = spec.trim();
  if (trimmed === '') {
    return '';
  }
  const isMac = platform === 'macos';
  const modifiers: string[] = [];
  let key = '';
  // A trailing `+` names the plus key: `Cmd++` splits into `["Cmd", "", ""]`, and
  // only that final empty token is a key rather than noise between modifiers.
  const parts = trimmed.split('+');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index].trim();
    if (part === '') {
      if (index === parts.length - 1) {
        key = '+';
      }
      continue;
    }
    const modifier = isMac
      ? MAC_SYMBOLS[part.toLowerCase()]
      : OTHER_MODIFIERS[part.toLowerCase()];
    if (modifier != null) {
      modifiers.push(modifier);
      continue;
    }
    key = keyLabel(part, isMac);
  }
  if (modifiers.length === 0) {
    return key;
  }
  return isMac
    ? `${modifiers.join('')}${key}`
    : `${modifiers.join('+')}+${key}`;
}
