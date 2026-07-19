export const ARIA_SNAPSHOT_SCRIPT_MARKER = "__PASEO_ARIA_SNAPSHOT__";

// Adapted from Playwright's injected ARIA snapshot model.
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0.
export const ARIA_SNAPSHOT_SCRIPT = String.raw`(() => {
  const MARKER = ${JSON.stringify(ARIA_SNAPSHOT_SCRIPT_MARKER)};
  const MAX_NODES = 1500;
  const MAX_REFS = 500;
  const MAX_TEXT_LENGTH = 80000;
  const ACTIONABLE_ROLES = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'menuitem',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem'
  ]);

  function normalizeText(value) {
    return String(value || '').replace(/[\u200b\u00ad]/g, '').replace(/[\r\n\s\t]+/g, ' ').trim();
  }

  function visibilityFor(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? 'box' : 'boxless';
  }

  function explicitRole(element) {
    const role = element.getAttribute('role');
    if (!role || role === 'presentation' || role === 'none') return null;
    return role.split(/\s+/)[0].toLowerCase();
  }

  function implicitRole(element) {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (element instanceof HTMLElement && element.isContentEditable) return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'main') return 'main';
    if (tag === 'nav') return 'navigation';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'section') return element.getAttribute('aria-label') ? 'region' : null;
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'iframe') return 'iframe';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return null;
      return 'textbox';
    }
    return null;
  }

  function roleFor(element) {
    return explicitRole(element) || implicitRole(element);
  }

  function labelText(element) {
    if (!(element instanceof HTMLElement)) return '';
    if (element.id) {
      const escapedId = window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape(element.id)
        : String(element.id).replace(/"/g, '\\"');
      const label = document.querySelector('label[for="' + escapedId + '"]');
      if (label) return normalizeText(label.textContent);
    }
    const closestLabel = element.closest('label');
    return closestLabel ? normalizeText(closestLabel.textContent) : '';
  }

  function nameFor(element, role) {
    const tag = element.tagName.toLowerCase();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      const normalized = normalizeText(text);
      if (normalized) return normalized;
    }
    const pieces = [
      element.getAttribute('aria-label'),
      labelText(element),
      element.getAttribute('alt'),
      element.getAttribute('title'),
      tag === 'input' || tag === 'textarea' ? element.getAttribute('placeholder') : null,
      tag === 'input' || tag === 'textarea' ? element.value : null,
      role === 'button' || role === 'link' || role === 'heading' || ACTIONABLE_ROLES.has(role)
        ? element.textContent
        : null
    ];
    return normalizeText(pieces.find((piece) => normalizeText(piece).length > 0) || '');
  }

  function fingerprintNameFor(element, role, name) {
    const tag = element.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return name;
    const mutableValue = normalizeText(element.value);
    if (!mutableValue || name !== mutableValue) return name;
    return '';
  }

  function inheritedDisabled(element) {
    if (!(element instanceof Element)) return false;
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return true;
    if (element.closest('fieldset[disabled]')) return true;
    return element.closest('[aria-disabled="true"]') !== null;
  }

  function isActionable(element, role) {
    if (!role || !ACTIONABLE_ROLES.has(role)) return false;
    if (visibilityFor(element) !== 'box') return false;
    if (inheritedDisabled(element)) return false;
    return true;
  }

  function fingerprintFor(element, role, name) {
    return {
      role,
      name: fingerprintNameFor(element, role, name),
      tagName: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || '',
      ariaLabel: element.getAttribute('aria-label') || ''
    };
  }

  function fingerprintMatches(element, fingerprint) {
    const role = roleFor(element) || 'generic';
    const name = nameFor(element, role);
    const current = fingerprintFor(element, role, name);
    return current.role === fingerprint.role &&
      current.name === fingerprint.name &&
      current.tagName === fingerprint.tagName &&
      current.type === fingerprint.type &&
      current.ariaLabel === fingerprint.ariaLabel;
  }

  function ensureRuntime() {
    const runtime = {
      refs: new Map(),
      resolve(ref, fingerprint) {
        const element = this.refs.get(ref);
        if (!element || !element.isConnected || !fingerprintMatches(element, fingerprint)) {
          return { ok: false, reason: 'stale_ref' };
        }
        return { ok: true, element };
      }
    };
    Object.defineProperty(window, '__PASEO_BROWSER_AUTOMATION__', {
      configurable: true,
      enumerable: false,
      value: runtime
    });
    return runtime;
  }

  function stateAttributes(element, role) {
    const attrs = [];
    if (role === 'heading') {
      const tag = element.tagName.toLowerCase();
      const level = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : Number(element.getAttribute('aria-level') || 0);
      if (level) attrs.push('level=' + level);
    }
    if (element.matches?.('input[type="checkbox"], input[type="radio"]')) {
      attrs.push('checked=' + (element.checked ? 'true' : 'false'));
    }
    if (element.getAttribute('aria-checked')) attrs.push('checked=' + element.getAttribute('aria-checked'));
    if (element.getAttribute('aria-expanded')) attrs.push('expanded=' + element.getAttribute('aria-expanded'));
    if (element.getAttribute('aria-pressed')) attrs.push('pressed=' + element.getAttribute('aria-pressed'));
    if (element.getAttribute('aria-selected')) attrs.push('selected=' + element.getAttribute('aria-selected'));
    return attrs;
  }

  function textNode(text) {
    return { kind: 'text', text };
  }

  function elementNode(element, role, name) {
    return {
      kind: 'role',
      role: role || 'generic',
      name,
      tagName: element.tagName.toLowerCase(),
      attributes: stateAttributes(element, role),
      children: []
    };
  }

  let nodeCount = 0;
  let refCount = 0;
  let iframeCount = 0;
  let maxDepth = 0;
  let truncated = false;
  let textBudget = MAX_TEXT_LENGTH;
  const runtime = ensureRuntime();

  function countNode(depth) {
    if (nodeCount >= MAX_NODES) {
      truncated = true;
      return false;
    }
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    return true;
  }

  function cappedText(text) {
    if (text.length <= textBudget) {
      textBudget -= text.length;
      return text;
    }
    truncated = true;
    const capped = text.slice(0, Math.max(0, textBudget));
    textBudget = 0;
    return capped;
  }

  function visitNode(domNode, depth) {
    if (!countNode(depth)) return null;
    if (domNode.nodeType === Node.TEXT_NODE) {
      const text = cappedText(normalizeText(domNode.textContent));
      if (!text) return null;
      return textNode(text);
    }
    if (!(domNode instanceof Element)) return null;
    const visibility = visibilityFor(domNode);
    if (!visibility) return null;
    if (domNode.getAttribute('aria-hidden') === 'true') return null;

    const role = roleFor(domNode);
    const name = role ? nameFor(domNode, role) : '';
    const children = [];
    for (const child of Array.from(domNode.childNodes)) {
      const childSnapshot = visitNode(child, depth + 1);
      if (childSnapshot) children.push(childSnapshot);
      if (truncated) break;
    }

    if (domNode.tagName.toLowerCase() === 'iframe') {
      iframeCount += 1;
    }

    if (visibility === 'boxless') {
      return children.length > 0 ? { kind: 'group', children } : null;
    }
    if (!role && children.length === 0) return null;
    const snapshotNode = role ? elementNode(domNode, role, name) : { kind: 'group', children: [] };
    snapshotNode.children = children;
    if (role && isActionable(domNode, role) && refCount < MAX_REFS) {
      const ref = '@e' + (refCount + 1);
      const fingerprint = fingerprintFor(domNode, role, name);
      refCount += 1;
      runtime.refs.set(ref, domNode);
      snapshotNode.ref = ref;
      snapshotNode.fingerprint = fingerprint;
    } else if (role && isActionable(domNode, role)) {
      truncated = true;
    }
    return snapshotNode;
  }

  const root = {
    kind: 'role',
    role: 'document',
    name: normalizeText(document.title),
    tagName: 'document',
    attributes: [],
    children: []
  };
  for (const child of Array.from(document.body ? document.body.childNodes : document.documentElement.childNodes)) {
    const childSnapshot = visitNode(child, 1);
    if (childSnapshot) root.children.push(childSnapshot);
    if (truncated) break;
  }

  return JSON.stringify({
    marker: MARKER,
    root,
    refs: Array.from(runtime.refs.entries()).map(([ref, element]) => {
      const role = roleFor(element) || 'generic';
      const name = nameFor(element, role);
      return { ref, fingerprint: fingerprintFor(element, role, name) };
    }),
    truncated,
    stats: { nodeCount, refCount, textLength: 0, iframeCount, maxDepth }
  });
})()`;
