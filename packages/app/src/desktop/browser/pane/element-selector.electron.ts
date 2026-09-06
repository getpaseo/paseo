import type { BrowserElementAttachment } from "@/attachments/types";
import type { BrowserElementJson, BrowserElementOption } from "@/desktop/browser/element-context";

export type BrowserElementSelection = Omit<BrowserElementAttachment, "formatted" | "comment"> & {
  attributes?: Record<string, string>;
  runtimeProperties?: {
    value?: BrowserElementJson;
    checked?: boolean;
    disabled?: boolean;
    placeholder?: string;
    min?: number;
    max?: number;
    step?: number;
    multiple?: boolean;
    options?: BrowserElementOption[];
    hasChildElements?: boolean;
  };
};

export type ElementSelectorMode = "annotate" | "screenshot";

export type ElementSelectorOutcome =
  | { type: "selected"; mode: ElementSelectorMode; selection: BrowserElementSelection }
  | { type: "cancelled" }
  | { type: "failed"; reason: "loading" | "timeout" | "unavailable" };

export type ElementSelectorStartResult = "started" | "loading" | "unavailable";

export interface ElementSelectorWebview extends HTMLElement {
  isLoading?: () => boolean;
  executeJavaScript?: (code: string) => Promise<unknown>;
}

interface ElementSelectorSession {
  mode: ElementSelectorMode;
  token: string;
  webview: ElementSelectorWebview;
  onFinish: (outcome: ElementSelectorOutcome) => void;
  stopPolling?: () => void;
  timeoutId?: number;
}

export interface ElementSelectorController {
  start(input: {
    webview: ElementSelectorWebview;
    mode: ElementSelectorMode;
    onFinish: (outcome: ElementSelectorOutcome) => void;
  }): ElementSelectorStartResult;
  cancel(): void;
  stopForWebview(webview: ElementSelectorWebview): void;
}

export interface ElementSelectorRuntime {
  token(): string;
  install(
    webview: ElementSelectorWebview,
    sessionToken: string,
  ): Promise<"installed" | "loading" | "unavailable">;
  watch(
    webview: ElementSelectorWebview,
    sessionToken: string,
    onResult: (selection: BrowserElementSelection | null) => void,
  ): () => void;
  clear(webview: ElementSelectorWebview, sessionToken: string): void;
  destroy(webview: ElementSelectorWebview, sessionToken: string): void;
  timeout(callback: () => void): number;
  cancelTimeout(timeoutId: number): void;
}

const SELECTOR_TIMEOUT_MS = 30_000;

function executeWebviewJavaScript(webview: ElementSelectorWebview, code: string): Promise<unknown> {
  if (!webview.isConnected) {
    return Promise.resolve(null);
  }
  try {
    return webview.executeJavaScript?.(code) ?? Promise.resolve(null);
  } catch (error) {
    return Promise.reject(error);
  }
}

function ignoreWebviewJavaScriptError() {}

function destroyWebviewSelector(webview: ElementSelectorWebview, sessionToken: string): void {
  const token = JSON.stringify(sessionToken);
  void executeWebviewJavaScript(
    webview,
    `if (window.__paseoSelector?.sessionToken === ${token}) window.__paseoSelector.destroy();`,
  ).catch(ignoreWebviewJavaScriptError);
}

function clearWebviewSelector(webview: ElementSelectorWebview, sessionToken: string): void {
  const token = JSON.stringify(sessionToken);
  void executeWebviewJavaScript(
    webview,
    `if (window.__paseoSelector?.sessionToken === ${token}) window.__paseoSelector.destroy(); if (window.__paseoSelectorResult?.__paseoSessionToken === ${token}) window.__paseoSelectorResult = null;`,
  ).catch(ignoreWebviewJavaScriptError);
}

export function clearElementSelection(webview: ElementSelectorWebview): void {
  void executeWebviewJavaScript(
    webview,
    "if (window.__paseoSelector) window.__paseoSelector.destroy(); window.__paseoSelectorResult = null;",
  ).catch(ignoreWebviewJavaScriptError);
}

function readSelectorInstallation(
  value: unknown,
  sessionToken: string,
): "installed" | "loading" | "unavailable" {
  if (value === null || typeof value !== "object") {
    return "unavailable";
  }
  if (Reflect.get(value, "sessionToken") !== sessionToken) {
    return "unavailable";
  }
  if (Reflect.get(value, "installed") === true) {
    return "installed";
  }
  return Reflect.get(value, "reason") === "document-loading" ? "loading" : "unavailable";
}

function startSelectorResultPolling(input: {
  webview: ElementSelectorWebview;
  sessionToken: string;
  onResult: (selection: BrowserElementSelection | null) => void;
}): () => void {
  const { webview, sessionToken, onResult } = input;
  const token = JSON.stringify(sessionToken);
  let stopped = false;
  let timerId: number | undefined;

  const schedule = () => {
    if (!stopped) {
      timerId = window.setTimeout(poll, 200);
    }
  };
  const poll = () => {
    void (async () => {
      try {
        const raw = await executeWebviewJavaScript(
          webview,
          `JSON.stringify(window.__paseoSelectorResult?.__paseoSessionToken === ${token} ? window.__paseoSelectorResult : null)`,
        );
        const result = typeof raw === "string" ? JSON.parse(raw) : null;
        if (!result) {
          schedule();
          return;
        }
        stopped = true;
        await executeWebviewJavaScript(
          webview,
          `if (window.__paseoSelectorResult?.__paseoSessionToken === ${token}) window.__paseoSelectorResult = null;`,
        ).catch(ignoreWebviewJavaScriptError);
        const cancelled = result.__cancelled === true;
        delete result.__cancelled;
        delete result.__paseoSessionToken;
        onResult(cancelled ? null : (result as BrowserElementSelection));
      } catch {
        schedule();
      }
    })();
  };

  schedule();
  return () => {
    stopped = true;
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
    }
  };
}

export function buildElementSelectorScript(sessionToken: string): string {
  const token = JSON.stringify(sessionToken);
  return `
    (function() {
      var sessionToken = ${token};
      if (document.readyState === 'loading' || !document.head || !document.documentElement) {
        return { installed: false, reason: 'document-loading', sessionToken: sessionToken };
      }
      if (window.__paseoSelector) { window.__paseoSelector.destroy(); }
      window.__paseoSelectorResult = null;
      var style = document.createElement('style');
      style.textContent = [
        '.__paseo-hover { box-shadow: inset 0 0 0 2px #3b82f6 !important; cursor: crosshair !important; }',
        '.__paseo-selected { box-shadow: inset 0 0 0 2px #2563eb !important; }',
        '.__paseo-select-mode, .__paseo-select-mode * { cursor: crosshair !important; user-select: none !important; }',
        '.__paseo-select-mode *, .__paseo-select-mode *::before, .__paseo-select-mode *::after { animation: none !important; transition: none !important; }',
        '.__paseo-hover-label { position: fixed; z-index: 2147483647; pointer-events: none; max-width: 360px; padding: 4px 8px; border-radius: 6px; background: rgba(24,24,27,0.96); color: #fff; font: 500 11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; box-shadow: 0 2px 10px rgba(0,0,0,0.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.__paseo-hover-label .__paseo-tag { color: #93c5fd; }',
        '.__paseo-hover-label .__paseo-id { color: #fca5a5; }',
        '.__paseo-hover-label .__paseo-cls { color: #fcd34d; }',
        '.__paseo-hover-label .__paseo-dim { color: #a1a1aa; margin-left: 6px; }',
        '.__paseo-hover-label .__paseo-comp { color: #86efac; margin-left: 6px; }',
      ].join('\\n');
      document.head.appendChild(style);
      document.documentElement.classList.add('__paseo-select-mode');
      var hoverLabel = document.createElement('div');
      hoverLabel.className = '__paseo-hover-label';
      hoverLabel.style.display = 'none';
      document.documentElement.appendChild(hoverLabel);
      var last = null;
      var selected = null;
      var selecting = false;
      var touchPointer = null;
      var suppressNextClick = false;
      function escapeHtml(value) {
        return String(value).replace(/[&<>"]/g, function(ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;';
        });
      }
      function describeElement(el) {
        var tag = el.tagName ? el.tagName.toLowerCase() : 'node';
        var parts = ['<span class="__paseo-tag">' + escapeHtml(tag) + '</span>'];
        if (el.id) {
          parts.push('<span class="__paseo-id">#' + escapeHtml(el.id) + '</span>');
        }
        if (el.classList && el.classList.length) {
          var cls = Array.prototype.slice.call(el.classList, 0, 2)
            .filter(function(c) { return c.indexOf('__paseo') !== 0; })
            .map(function(c) { return '.' + escapeHtml(c); })
            .join('');
          if (cls) parts.push('<span class="__paseo-cls">' + cls + '</span>');
        }
        var comp = getReactSource(el);
        if (comp && comp.componentName) {
          parts.push('<span class="__paseo-comp">&lt;' + escapeHtml(comp.componentName) + '&gt;</span>');
        }
        var rect = el.getBoundingClientRect();
        parts.push('<span class="__paseo-dim">' + Math.round(rect.width) + '×' + Math.round(rect.height) + '</span>');
        return { html: parts.join(''), rect: rect };
      }
      function positionLabel(rect, e) {
        var lw = hoverLabel.offsetWidth || 0;
        var lh = hoverLabel.offsetHeight || 0;
        var top = rect.top - lh - 6;
        if (top < 4) top = rect.bottom + 6;
        if (top + lh > window.innerHeight - 4) top = Math.max(4, e.clientY - lh - 6);
        var left = rect.left;
        if (left + lw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - lw - 4);
        if (left < 4) left = 4;
        hoverLabel.style.top = Math.round(top) + 'px';
        hoverLabel.style.left = Math.round(left) + 'px';
      }
      function isInspectable(el) {
        if (!el || el.nodeType !== 1 || el === hoverLabel) return false;
        if (el.classList && (el.classList.contains('__paseo-hover-label') || el.classList.contains('__paseo-selected'))) return false;
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        var className = typeof el.className === 'string' ? el.className : '';
        var isEmptyBackdrop = /(^|[-_])(overlay|mask|backdrop)([-_]|$)/i.test(className)
          && rect.width >= window.innerWidth * 0.9
          && rect.height >= window.innerHeight * 0.9
          && !(el.innerText || '').trim();
        if (isEmptyBackdrop) return false;
        var current = el;
        while (current && current.nodeType === 1) {
          var computed = window.getComputedStyle(current);
          if (computed.display === 'none' || computed.visibility === 'hidden' || computed.visibility === 'collapse' || computed.contentVisibility === 'hidden') return false;
          var opacity = Number.parseFloat(computed.opacity || '1');
          if (Number.isFinite(opacity) && opacity <= 0.01) return false;
          current = current.parentElement;
        }
        return true;
      }
      function resolveTarget(e) {
        var candidates = typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(e.clientX, e.clientY)
          : [e.target];
        var fallback = null;
        for (var i = 0; i < candidates.length; i++) {
          var candidate = candidates[i];
          if (!isInspectable(candidate)) continue;
          if (candidate.tagName !== 'HTML' && candidate.tagName !== 'BODY') return candidate;
          if (!fallback) fallback = candidate;
        }
        return fallback;
      }
      function showTarget(el, e) {
        if (!el) return;
        if (last && last !== selected) last.classList.remove('__paseo-hover');
        if (el !== selected) el.classList.add('__paseo-hover');
        last = el;
        try {
          var info = describeElement(el);
          hoverLabel.innerHTML = info.html;
          hoverLabel.style.display = 'block';
          positionLabel(info.rect, e);
        } catch (err) {
          hoverLabel.style.display = 'none';
        }
      }
      function onMove(e) {
        e.preventDefault();
        e.stopPropagation();
        showTarget(resolveTarget(e), e);
      }
      function buildSelector(el) {
        var path = [];
        while (el && el.nodeType === 1) {
          var seg = CSS.escape(el.tagName.toLowerCase());
          if (el.id) {
            var idSelector = '#' + CSS.escape(el.id);
            if (document.querySelectorAll(idSelector).length === 1) {
              path.unshift(idSelector);
              break;
            }
          }
          var sib = el, nth = 1;
          while (sib = sib.previousElementSibling) { if (sib.tagName === el.tagName) nth++; }
          seg += ':nth-of-type(' + nth + ')';
          path.unshift(seg);
          el = el.parentElement;
        }
        return path.join(' > ');
      }
      function getReactSource(el) {
        var keys = Object.keys(el);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].startsWith('__reactFiber$') || keys[i].startsWith('__reactInternalInstance$')) {
            var fiber = el[keys[i]];
            while (fiber) {
              if (fiber._debugSource) {
                return {
                  fileName: fiber._debugSource.fileName || null,
                  lineNumber: fiber._debugSource.lineNumber || null,
                  columnNumber: fiber._debugSource.columnNumber || null,
                  componentName: (fiber.type && (typeof fiber.type === 'string' ? fiber.type : fiber.type.displayName || fiber.type.name)) || null
                };
              }
              if (fiber._debugOwner) { fiber = fiber._debugOwner; }
              else if (fiber.return) { fiber = fiber.return; }
              else break;
            }
          }
        }
        return null;
      }
      function getParentChain(el, depth) {
        var chain = [];
        var cur = el.parentElement;
        for (var i = 0; i < (depth || 5) && cur; i++) {
          var desc = cur.tagName.toLowerCase();
          if (cur.id) desc += '#' + cur.id;
          if (cur.className && typeof cur.className === 'string') { var cls = cur.className.trim().replace(/  +/g, ' ').split(' ').slice(0,2).join('.'); if (cls) desc += '.' + cls; }
          chain.push(desc);
          cur = cur.parentElement;
        }
        return chain;
      }
      function getChildSummary(el, max) {
        var kids = [];
        for (var i = 0; i < Math.min(el.children.length, max || 8); i++) {
          var c = el.children[i];
          var desc = c.tagName.toLowerCase();
          if (c.id) desc += '#' + c.id;
          kids.push(desc);
        }
        if (el.children.length > (max || 8)) kids.push('...(' + el.children.length + ' total)');
        return kids;
      }
      function getRelevantStyles(el) {
        var cs = window.getComputedStyle(el);
        var pick = ['display','position','width','height','color','background-color','font-size','font-family','font-weight','padding','margin','border','flex','grid-template-columns','gap','overflow','opacity','z-index'];
        var out = {};
        pick.forEach(function(p) {
          var v = cs.getPropertyValue(p);
          if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') out[p] = v;
        });
        return out;
      }
      function getRuntimeProperties(el) {
        var out = { hasChildElements: el.children.length > 0 };
        if ('disabled' in el) out.disabled = Boolean(el.disabled);
        if ('placeholder' in el && el.placeholder) out.placeholder = String(el.placeholder).substring(0, 500);
        var inputType = String(el.type || '').toLowerCase();
        if (inputType === 'checkbox' || inputType === 'radio') out.checked = Boolean(el.checked);
        if ('value' in el && inputType !== 'password' && inputType !== 'file') {
          if (el.tagName.toLowerCase() === 'select' && el.multiple) {
            out.value = Array.prototype.filter.call(el.options, function(option) { return option.selected; }).map(function(option) { return option.value; });
          } else {
            out.value = String(el.value).substring(0, 2000);
          }
        }
        ['min', 'max', 'step'].forEach(function(key) {
          if (!(key in el) || el[key] === '') return;
          var number = Number(el[key]);
          if (Number.isFinite(number)) out[key] = number;
        });
        if (el.tagName.toLowerCase() === 'select') {
          out.multiple = Boolean(el.multiple);
          out.options = Array.prototype.slice.call(el.options, 0, 200).map(function(option) {
            return { label: String(option.label || option.text).substring(0, 300), value: String(option.value).substring(0, 2000), disabled: Boolean(option.disabled) };
          });
        }
        return out;
      }
      async function selectAt(e) {
        if (selecting) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        var el = resolveTarget(e);
        if (!el) return;
        selecting = true;
        selected = el;
        if (last) last.classList.remove('__paseo-hover');
        selected.classList.add('__paseo-selected');
        hoverLabel.style.display = 'none';
        var attrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
          attrs[el.attributes[i].name] = el.attributes[i].value;
        }
        var rect = el.getBoundingClientRect();
        var result = {
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || '').substring(0, 500),
          selector: buildSelector(el),
          attributes: attrs,
          url: location.href,
          outerHTML: el.outerHTML.substring(0, 2000),
          computedStyles: getRelevantStyles(el),
          runtimeProperties: getRuntimeProperties(el),
          __paseoSessionToken: sessionToken,
          boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          reactSource: getReactSource(el),
          parentChain: getParentChain(el, 5),
          children: getChildSummary(el, 8)
        };
        deactivate();
        if (e.type === 'click' && (el.type === 'checkbox' || el.type === 'radio')) {
          // Click cancellation restores checked state after native preactivation.
          await new Promise(function(resolve) { window.setTimeout(resolve, 0); });
          if (!window.__paseoSelector || window.__paseoSelector.sessionToken !== sessionToken) return;
          result.runtimeProperties = getRuntimeProperties(el);
        }
        window.__paseoSelectorResult = result;
      }
      function onClick(e) {
        if (suppressNextClick) {
          suppressNextClick = false;
          blockEvent(e);
          return;
        }
        void selectAt(e);
      }
      function stopEventPropagation(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      function suppressCompatibilityClick() {
        var timer = null;
        function cleanup() {
          document.removeEventListener('click', suppress, true);
          if (timer !== null) window.clearTimeout(timer);
        }
        function suppress(e) {
          blockEvent(e);
          cleanup();
        }
        document.addEventListener('click', suppress, true);
        timer = window.setTimeout(cleanup, 750);
      }
      function onPointerDown(e) {
        if (e.pointerType === 'touch' || e.pointerType === 'pen') {
          touchPointer = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
          stopEventPropagation(e);
          showTarget(resolveTarget(e), e);
          return;
        }
        blockEvent(e);
      }
      function onPointerMove(e) {
        if (e.pointerType === 'mouse') {
          onMove(e);
          return;
        }
        if (!touchPointer || touchPointer.id !== e.pointerId) return;
        if (Math.abs(e.clientX - touchPointer.x) > 8 || Math.abs(e.clientY - touchPointer.y) > 8) {
          touchPointer.moved = true;
        }
        stopEventPropagation(e);
        showTarget(resolveTarget(e), e);
      }
      function onPointerUp(e) {
        if (!touchPointer || touchPointer.id !== e.pointerId) return;
        var shouldSelect = !touchPointer.moved;
        touchPointer = null;
        if (shouldSelect) {
          suppressCompatibilityClick();
          void selectAt(e);
          return;
        }
        suppressNextClick = true;
        stopEventPropagation(e);
      }
      function onPointerCancel(e) {
        if (touchPointer && touchPointer.id === e.pointerId) touchPointer = null;
        stopEventPropagation(e);
      }
      function onKey(e) {
        if (e.key === 'Escape') {
          destroy();
          window.__paseoSelectorResult = { __cancelled: true, __paseoSessionToken: sessionToken };
        }
      }
      function blockEvent(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      function deactivate() {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', blockEvent, true);
        document.removeEventListener('mouseup', blockEvent, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('pointermove', onPointerMove, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('pointercancel', onPointerCancel, true);
        document.removeEventListener('focus', blockEvent, true);
        document.removeEventListener('submit', blockEvent, true);
        document.documentElement.classList.remove('__paseo-select-mode');
        if (last && last !== selected) last.classList.remove('__paseo-hover');
        if (hoverLabel.parentNode) hoverLabel.parentNode.removeChild(hoverLabel);
      }
      function destroy() {
        deactivate();
        if (selected) selected.classList.remove('__paseo-selected');
        style.remove();
        window.__paseoSelector = null;
      }
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', blockEvent, true);
      document.addEventListener('mouseup', blockEvent, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('pointercancel', onPointerCancel, true);
      document.addEventListener('focus', blockEvent, true);
      document.addEventListener('submit', blockEvent, true);
      window.__paseoSelector = { destroy: destroy, sessionToken: sessionToken };
      return { installed: true, sessionToken: sessionToken };
    })()
  `;
}

function browserSelectorRuntime(): ElementSelectorRuntime {
  let sequence = 0;
  return {
    token() {
      sequence += 1;
      return `${sequence}:${crypto.randomUUID()}`;
    },
    async install(webview, sessionToken) {
      const result = await executeWebviewJavaScript(
        webview,
        buildElementSelectorScript(sessionToken),
      );
      return readSelectorInstallation(result, sessionToken);
    },
    watch: (webview, sessionToken, onResult) =>
      startSelectorResultPolling({ webview, sessionToken, onResult }),
    clear: clearWebviewSelector,
    destroy: destroyWebviewSelector,
    timeout: (callback) => window.setTimeout(callback, SELECTOR_TIMEOUT_MS),
    cancelTimeout: (timeoutId) => window.clearTimeout(timeoutId),
  };
}

class ElementSelectorOwner implements ElementSelectorController {
  private current: ElementSelectorSession | null = null;

  constructor(private readonly runtime: ElementSelectorRuntime) {}

  start({
    webview,
    mode,
    onFinish,
  }: Parameters<ElementSelectorController["start"]>[0]): ElementSelectorStartResult {
    if (!webview.isConnected) return "unavailable";
    if (webview.isLoading?.()) return "loading";
    if (this.current) this.finish(this.current, { type: "cancelled" }, "clear");
    const session: ElementSelectorSession = {
      mode,
      token: this.runtime.token(),
      webview,
      onFinish,
    };
    this.current = session;
    session.timeoutId = this.runtime.timeout(() =>
      this.finish(session, { type: "failed", reason: "timeout" }, "destroy"),
    );
    void this.install(session);
    return "started";
  }

  cancel(): void {
    if (this.current) this.finish(this.current, { type: "cancelled" }, "clear");
  }

  stopForWebview(webview: ElementSelectorWebview): void {
    if (this.current?.webview === webview) {
      this.finish(this.current, { type: "cancelled" }, "destroy");
    }
  }

  private async install(session: ElementSelectorSession): Promise<void> {
    let state: "installed" | "loading" | "unavailable";
    try {
      state = await this.runtime.install(session.webview, session.token);
    } catch {
      this.finish(session, { type: "failed", reason: "unavailable" }, "destroy");
      return;
    }
    if (this.current !== session) {
      if (state === "installed") this.runtime.destroy(session.webview, session.token);
      return;
    }
    if (state !== "installed") {
      this.finish(session, { type: "failed", reason: state }, null);
      return;
    }
    session.stopPolling = this.runtime.watch(session.webview, session.token, (selection) =>
      this.finish(
        session,
        selection ? { type: "selected", mode: session.mode, selection } : { type: "cancelled" },
        null,
      ),
    );
  }

  private finish(
    session: ElementSelectorSession,
    outcome: ElementSelectorOutcome,
    cleanup: "clear" | "destroy" | null,
  ): boolean {
    if (this.current !== session) return false;
    session.stopPolling?.();
    session.stopPolling = undefined;
    if (session.timeoutId !== undefined) {
      this.runtime.cancelTimeout(session.timeoutId);
      session.timeoutId = undefined;
    }
    this.current = null;
    if (cleanup) this.runtime[cleanup](session.webview, session.token);
    session.onFinish(outcome);
    return true;
  }
}

export function createElementSelectorController(
  runtime: ElementSelectorRuntime = browserSelectorRuntime(),
): ElementSelectorController {
  return new ElementSelectorOwner(runtime);
}
