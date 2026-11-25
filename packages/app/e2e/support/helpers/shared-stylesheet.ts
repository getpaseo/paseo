import type { Page } from "@playwright/test";

/**
 * The shared stylesheet is `#unistyles-web`: one rule per generated style class, for the whole app.
 * Every change to it makes the browser restyle, and replacing a rule that is still in use restyles
 * the entire document. A spec remembers the stylesheet, performs an interaction, and reads back
 * everything that happened to it in between, including rules that came and went before the read.
 */
export interface SharedStylesheetChanges {
  /** Rules inserted, counting ones deleted again before the read. */
  added: number;
  /** Rules deleted, counting ones inserted during the interaction. */
  removed: number;
  /** Rules whose declarations were changed in place. */
  edited: number;
  /** Rules for classes still in use that were thrown away and created again. */
  rebuilt: number;
}

interface SharedStylesheetRule {
  rule: CSSRule;
  text: string;
}

interface SharedStylesheetWatch {
  rules: Map<string, SharedStylesheetRule>;
  added: number;
  removed: number;
  edited: number;
  editedRules: Set<CSSRule>;
}

declare global {
  interface Window {
    __PASEO_SHARED_STYLESHEET_WATCH__?: SharedStylesheetWatch;
  }
}

function readSharedStylesheetRules(): Map<string, SharedStylesheetRule> {
  const tag = document.getElementById("unistyles-web");
  if (!(tag instanceof HTMLStyleElement) || !tag.sheet) {
    throw new Error("Shared stylesheet is missing");
  }
  const rules = new Map<string, SharedStylesheetRule>();
  const collect = (list: CSSRuleList, group: string) => {
    for (const rule of list) {
      if (rule instanceof CSSStyleRule) {
        rules.set(`${group}${rule.selectorText}`, { rule, text: rule.cssText });
      } else if (rule instanceof CSSMediaRule) {
        collect(rule.cssRules, `${rule.conditionText} `);
      }
    }
  };
  collect(tag.sheet.cssRules, "");
  return rules;
}

// The CSSOM has no mutation events, so the watch wraps the calls that change a stylesheet and
// counts the ones that land in the shared stylesheet, including changes undone before the read.
// Chromium sets named properties such as `style.width` without an accessor the watch can wrap;
// reading the changes compares rule text to catch those. Installed once per page.
function installSharedStylesheetWatch(): void {
  const marker = "__PASEO_SHARED_STYLESHEET_WATCHED__";
  const flags = window as unknown as Record<string, boolean>;
  if (flags[marker]) return;
  flags[marker] = true;

  const isShared = (sheet: CSSStyleSheet | null | undefined) => {
    const tag = document.getElementById("unistyles-web");
    return Boolean(sheet) && tag instanceof HTMLStyleElement && sheet === tag.sheet;
  };
  const watch = () => window.__PASEO_SHARED_STYLESHEET_WATCH__;
  const wrapMethod = <Target>(
    prototype: object,
    name: string,
    owner: (target: Target) => CSSStyleSheet | null | undefined,
    record: (target: Target) => void,
  ) => {
    const original = Reflect.get(prototype, name) as (...args: unknown[]) => unknown;
    Reflect.set(prototype, name, function (this: Target, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (isShared(owner(this))) record(this);
      return result;
    });
  };
  const countAdded = () => {
    const current = watch();
    if (current) current.added += 1;
  };
  const countRemoved = () => {
    const current = watch();
    if (current) current.removed += 1;
  };
  const countEdited = (style: CSSStyleDeclaration) => {
    const current = watch();
    if (!current) return;
    current.edited += 1;
    if (style.parentRule) current.editedRules.add(style.parentRule);
  };
  const sheetOf = (sheet: CSSStyleSheet) => sheet;
  const groupSheet = (group: CSSGroupingRule) => group.parentStyleSheet;
  const declarationSheet = (style: CSSStyleDeclaration) => style.parentRule?.parentStyleSheet;

  wrapMethod(CSSStyleSheet.prototype, "insertRule", sheetOf, countAdded);
  wrapMethod(CSSStyleSheet.prototype, "deleteRule", sheetOf, countRemoved);
  wrapMethod(CSSGroupingRule.prototype, "insertRule", groupSheet, countAdded);
  wrapMethod(CSSGroupingRule.prototype, "deleteRule", groupSheet, countRemoved);
  wrapMethod(CSSStyleDeclaration.prototype, "setProperty", declarationSheet, countEdited);
  wrapMethod(CSSStyleDeclaration.prototype, "removeProperty", declarationSheet, countEdited);

  const cssText = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "cssText");
  const setCssText = cssText?.set;
  if (!cssText || !setCssText) throw new Error("CSSStyleDeclaration.cssText has no setter");
  Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", {
    ...cssText,
    set(this: CSSStyleDeclaration, value: string) {
      setCssText.call(this, value);
      if (isShared(declarationSheet(this))) countEdited(this);
    },
  });
}

export async function rememberSharedStylesheet(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    (${installSharedStylesheetWatch.toString()})();
    window.__PASEO_SHARED_STYLESHEET_WATCH__ = {
      rules: (${readSharedStylesheetRules.toString()})(),
      added: 0,
      removed: 0,
      edited: 0,
      editedRules: new Set(),
    };
  })()`);
}

export async function readSharedStylesheetChanges(page: Page): Promise<SharedStylesheetChanges> {
  return page.evaluate(`(() => {
    const watch = window.__PASEO_SHARED_STYLESHEET_WATCH__;
    if (!watch) throw new Error("Shared stylesheet was not remembered");
    const after = (${readSharedStylesheetRules.toString()})();
    let edited = watch.edited;
    let rebuilt = 0;
    for (const [selector, { rule, text }] of after) {
      const before = watch.rules.get(selector);
      if (!before) continue;
      if (before.rule !== rule) rebuilt += 1;
      else if (before.text !== text && !watch.editedRules.has(rule)) edited += 1;
    }
    return { added: watch.added, removed: watch.removed, edited, rebuilt };
  })()`);
}
