import type { BrowserElementChange } from "@/desktop/browser/element-context";
import type { BrowserElementSelection, ElementSelectorWebview } from "./element-selector.electron";

const previewQueues = new WeakMap<ElementSelectorWebview, Promise<boolean>>();

function executePreviewScript(webview: ElementSelectorWebview, code: string): Promise<boolean> {
  const previous = previewQueues.get(webview) ?? Promise.resolve(true);
  const next = previous
    .catch(() => false)
    .then(async () => {
      if (!webview.isConnected || !webview.executeJavaScript) return false;
      return (await webview.executeJavaScript(code)) === true;
    })
    .catch(() => false);
  previewQueues.set(webview, next);
  return next;
}

export function buildElementPreviewScript(input: {
  selector: string;
  changes: readonly BrowserElementChange[];
}): string {
  const payload = JSON.stringify(input);
  return `
    (function() {
      var input = ${payload};
      var existing = window.__paseoElementPreview;
      if (existing && existing.selector !== input.selector) {
        existing.restore();
        existing = null;
      }
      var target = null;
      try { target = document.querySelector(input.selector); } catch (error) { target = null; }
      if (!target) return false;
      if (!existing || existing.target !== target) {
        if (existing) existing.restore();
        var snapshots = { styles: {}, attributes: {} };
        existing = {
          selector: input.selector,
          target: target,
          snapshots: snapshots,
          restore: function() {
            var el = this.target;
            if (!el) return;
            if (Object.prototype.hasOwnProperty.call(snapshots, 'textContent')) el.textContent = snapshots.textContent;
            if (Object.prototype.hasOwnProperty.call(snapshots, 'value')) el.value = snapshots.value;
            if (Object.prototype.hasOwnProperty.call(snapshots, 'checked')) el.checked = snapshots.checked;
            if (snapshots.options) snapshots.options.forEach(function(snapshot) { snapshot.option.selected = snapshot.selected; });
            if (snapshots.radios) snapshots.radios.forEach(function(snapshot) { snapshot.radio.checked = snapshot.checked; });
            Object.keys(snapshots.attributes).forEach(function(name) {
              var value = snapshots.attributes[name];
              if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
            });
            Object.keys(snapshots.styles).forEach(function(name) {
              var style = snapshots.styles[name];
              if (style.value) el.style.setProperty(name, style.value, style.priority);
              else el.style.removeProperty(name);
            });
          },
          destroy: function() {
            this.restore();
            if (window.__paseoElementPreview === this) window.__paseoElementPreview = null;
          }
        };
        window.__paseoElementPreview = existing;
      }
      existing.restore();
      var snapshots = existing.snapshots;
      input.changes.forEach(function(change) {
        var path = change.path || change.fieldId;
        var value = change.to;
        if (path === 'text' && target.children.length === 0) {
          if (!Object.prototype.hasOwnProperty.call(snapshots, 'textContent')) snapshots.textContent = target.textContent;
          target.textContent = value == null ? '' : String(value);
          return;
        }
        if (path === 'value' && 'value' in target) {
          if (target.tagName === 'SELECT' && target.multiple) {
            if (!snapshots.options) snapshots.options = Array.from(target.options, function(option) { return { option: option, selected: option.selected }; });
            var values = Array.isArray(value) ? value.map(String) : [];
            Array.from(target.options).forEach(function(option) { option.selected = values.indexOf(option.value) !== -1; });
            return;
          }
          if (!Object.prototype.hasOwnProperty.call(snapshots, 'value')) snapshots.value = target.value;
          target.value = value == null ? '' : String(value);
          return;
        }
        if (path === 'checked' && 'checked' in target) {
          if (target.type === 'radio' && target.name && !snapshots.radios) {
            snapshots.radios = Array.from(target.getRootNode().querySelectorAll('input[type="radio"]'))
              .filter(function(radio) { return radio.name === target.name && radio.form === target.form; })
              .map(function(radio) { return { radio: radio, checked: radio.checked }; });
          }
          if (!Object.prototype.hasOwnProperty.call(snapshots, 'checked')) snapshots.checked = target.checked;
          target.checked = Boolean(value);
          return;
        }
        if (path === 'alt') {
          if (!Object.prototype.hasOwnProperty.call(snapshots.attributes, 'alt')) snapshots.attributes.alt = target.getAttribute('alt');
          if (value == null) target.removeAttribute('alt'); else target.setAttribute('alt', String(value));
          return;
        }
        if (path.indexOf('style.') === 0) {
          var property = path.slice(6);
          if (!property) return;
          if (!Object.prototype.hasOwnProperty.call(snapshots.styles, property)) {
            snapshots.styles[property] = {
              value: target.style.getPropertyValue(property),
              priority: target.style.getPropertyPriority(property)
            };
          }
          if (value == null || value === '') target.style.removeProperty(property);
          else target.style.setProperty(property, String(value), 'important');
        }
      });
      return true;
    })()
  `;
}

export function previewElementChanges(
  webview: ElementSelectorWebview,
  selection: BrowserElementSelection,
  changes: readonly BrowserElementChange[],
): Promise<boolean> {
  return executePreviewScript(
    webview,
    buildElementPreviewScript({ selector: selection.selector, changes }),
  );
}

export function restoreElementPreview(webview: ElementSelectorWebview): Promise<boolean> {
  return executePreviewScript(
    webview,
    "(function() { if (window.__paseoElementPreview) window.__paseoElementPreview.destroy(); return true; })()",
  );
}
