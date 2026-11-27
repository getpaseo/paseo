export interface LinkPressEvent {
  url: string;
  /** Syntax of the tapped occurrence, independent of other links with the same URL. */
  sourceType?: 'markdown' | 'text' | 'inline-code';
}

export interface LinkLongPressEvent {
  url: string;
}

export interface ImagePressEvent {
  url: string;
  altText: string;
}

export interface TaskListItemPressEvent {
  index: number;
  checked: boolean;
  text: string;
}

export interface CopyPressEvent {
  code: string;
  language: string;
}

export interface CodeBlockPressEvent {
  code: string;
  language: string;
}

/**
 * Event payload fired when a math expression fails to parse or render.
 *
 * The whole expression is the unit of failure: the LaTeX engine either renders
 * an expression in full or rejects it, so there is no single offending command
 * to report. Consumers can classify `source` themselves (e.g. report it to an
 * error tracker) without maintaining an allowlist that goes stale on engine
 * upgrades.
 */
export interface LatexErrorEvent {
  /** Raw LaTeX of the failing expression, without `$`/`$$` delimiters. */
  source: string;
  /** Engine error message, when one is available. */
  message?: string;
  /** `false` for inline `$...$`, `true` for block `$$...$$`. */
  displayMode: boolean;
}

/** A link menu item as sent to native: no callback, every field set. */
export interface LinkContextMenuItemConfig {
  text: string;
  icon: string;
  disabled: boolean;
  destructive: boolean;
}

/** The menu items for links whose URL matches `pattern`. */
export interface LinkContextMenuItemsConfig {
  pattern: string;
  items: ReadonlyArray<Readonly<LinkContextMenuItemConfig>>;
}

/** `pattern` is the entry that supplied the menu, so JS finds the item without matching again. */
export interface OnLinkContextMenuItemPressEvent {
  url: string;
  pattern: string;
  itemText: string;
}

/**
 * Native-level context menu item config sent to the native component.
 * Does not include the `onPress` callback — callbacks are managed on the JS side.
 */
export interface ContextMenuItemConfig {
  text: string;
  icon?: string;
}

/**
 * Event payload fired by the native component when a context menu item is pressed.
 */
export interface OnContextMenuItemPressEvent {
  itemText: string;
  selectedText: string;
  selectionStart: number;
  selectionEnd: number;
}
