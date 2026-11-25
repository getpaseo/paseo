import type { Page } from "@playwright/test";

/**
 * The shared stylesheet is `#unistyles-web`: one rule per generated style class, for the whole app.
 * Replacing a rule that is still in use makes the browser restyle the entire document, so a spec
 * remembers the rules, performs an interaction, and reads back what happened to them.
 */
export interface SharedStylesheetChanges {
  /** Rules for classes the interaction introduced. */
  added: number;
  /** Rules for classes nothing uses any more. */
  removed: number;
  /** Rules still in use that were thrown away and created again. */
  rebuilt: number;
}

declare global {
  interface Window {
    __PASEO_SHARED_STYLESHEET_RULES__?: Map<string, CSSRule>;
  }
}

function readSharedStylesheetRules(): Map<string, CSSRule> {
  const tag = document.getElementById("unistyles-web");
  if (!(tag instanceof HTMLStyleElement) || !tag.sheet) {
    throw new Error("Shared stylesheet is missing");
  }
  const rules = new Map<string, CSSRule>();
  const collect = (list: CSSRuleList, group: string) => {
    for (const rule of list) {
      if (rule instanceof CSSStyleRule) rules.set(`${group}${rule.selectorText}`, rule);
      else if (rule instanceof CSSMediaRule) collect(rule.cssRules, `${rule.conditionText} `);
    }
  };
  collect(tag.sheet.cssRules, "");
  return rules;
}

export async function rememberSharedStylesheet(page: Page): Promise<void> {
  await page.evaluate(
    `window.__PASEO_SHARED_STYLESHEET_RULES__ = (${readSharedStylesheetRules.toString()})()`,
  );
}

export async function readSharedStylesheetChanges(page: Page): Promise<SharedStylesheetChanges> {
  return page.evaluate(`(() => {
    const before = window.__PASEO_SHARED_STYLESHEET_RULES__;
    if (!before) throw new Error("Shared stylesheet was not remembered");
    const after = (${readSharedStylesheetRules.toString()})();
    const changes = { added: 0, removed: 0, rebuilt: 0 };
    for (const [selector, rule] of after) {
      if (!before.has(selector)) changes.added += 1;
      else if (before.get(selector) !== rule) changes.rebuilt += 1;
    }
    for (const selector of before.keys()) {
      if (!after.has(selector)) changes.removed += 1;
    }
    return changes;
  })()`);
}
