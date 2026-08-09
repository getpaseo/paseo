export const DESTROY_MOBILE_BROWSER_SELECTOR_SCRIPT =
  "if(window.__paseoMobileSelector)window.__paseoMobileSelector.destroy();true;";

/** Builds the touch selector injected only after an explicit user action. */
export function buildMobileBrowserSelectorScript(): string {
  return `
    (function() {
      if (window.__paseoMobileSelector) window.__paseoMobileSelector.destroy();
      var highlighted = null;
      var style = document.createElement('style');
      style.textContent = '.__paseo-mobile-hover{outline:3px solid #3b82f6!important;outline-offset:2px!important;}';
      (document.head || document.documentElement).appendChild(style);

      function targetAt(event) {
        var touch = event.changedTouches && event.changedTouches[0];
        var x = touch ? touch.clientX : event.clientX;
        var y = touch ? touch.clientY : event.clientY;
        return document.elementFromPoint(x, y);
      }
      function highlight(event) {
        var target = targetAt(event);
        if (!target || target === document.documentElement) return;
        if (highlighted) highlighted.classList.remove('__paseo-mobile-hover');
        highlighted = target;
        highlighted.classList.add('__paseo-mobile-hover');
      }
      function selectorFor(element) {
        if (element.id) return '#' + CSS.escape(element.id);
        var path = [];
        while (element && element.nodeType === 1) {
          var segment = element.tagName.toLowerCase();
          var sibling = element;
          var position = 1;
          while ((sibling = sibling.previousElementSibling)) {
            if (sibling.tagName === element.tagName) position++;
          }
          if (position > 1) segment += ':nth-of-type(' + position + ')';
          path.unshift(segment);
          element = element.parentElement;
        }
        return path.join(' > ');
      }
      function reactSource(element) {
        var keys = Object.keys(element);
        for (var index = 0; index < keys.length; index++) {
          if (!keys[index].startsWith('__reactFiber$') && !keys[index].startsWith('__reactInternalInstance$')) continue;
          var fiber = element[keys[index]];
          while (fiber) {
            if (fiber._debugSource) {
              var type = fiber.type;
              return {
                fileName: fiber._debugSource.fileName || null,
                lineNumber: fiber._debugSource.lineNumber || null,
                columnNumber: fiber._debugSource.columnNumber || null,
                componentName: (type && (typeof type === 'string' ? type : type.displayName || type.name)) || null
              };
            }
            fiber = fiber._debugOwner || fiber.return;
          }
        }
        return null;
      }
      function describe(element) {
        var rect = element.getBoundingClientRect();
        var computed = getComputedStyle(element);
        var styleNames = ['display','position','width','height','color','background-color','font-size','font-family','padding','margin','border','flex','grid-template-columns','gap','overflow','opacity','z-index'];
        var styles = {};
        styleNames.forEach(function(name) {
          var value = computed.getPropertyValue(name);
          if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== '0px' && value !== 'rgba(0, 0, 0, 0)') styles[name] = value;
        });
        var parents = [];
        var parent = element.parentElement;
        while (parent && parents.length < 5) {
          parents.push(parent.tagName.toLowerCase() + (parent.id ? '#' + parent.id : ''));
          parent = parent.parentElement;
        }
        var children = Array.prototype.slice.call(element.children, 0, 8).map(function(child) {
          return child.tagName.toLowerCase() + (child.id ? '#' + child.id : '');
        });
        var attributes = {};
        Array.prototype.forEach.call(element.attributes || [], function(attribute) {
          attributes[attribute.name] = attribute.value;
        });
        return {
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || '').slice(0, 500),
          selector: selectorFor(element),
          attributes: attributes,
          url: location.href,
          outerHTML: (element.outerHTML || '').slice(0, 2000),
          computedStyles: styles,
          boundingRect: {
            x: Math.max(0, Math.round(rect.x)),
            y: Math.max(0, Math.round(rect.y)),
            width: Math.max(0, Math.round(rect.width)),
            height: Math.max(0, Math.round(rect.height))
          },
          reactSource: reactSource(element),
          parentChain: parents,
          children: children
        };
      }
      function finish(event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        var target = targetAt(event) || highlighted;
        if (!target) return;
        var result = describe(target);
        destroy();
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'paseo-selection', selection: result }));
      }
      function block(event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
      function destroy() {
        document.removeEventListener('touchmove', highlight, true);
        document.removeEventListener('touchend', finish, true);
        document.removeEventListener('pointermove', highlight, true);
        document.removeEventListener('click', finish, true);
        document.removeEventListener('touchstart', block, true);
        document.removeEventListener('pointerdown', block, true);
        if (highlighted) highlighted.classList.remove('__paseo-mobile-hover');
        style.remove();
        window.__paseoMobileSelector = null;
      }
      document.addEventListener('touchmove', highlight, true);
      document.addEventListener('touchend', finish, true);
      document.addEventListener('pointermove', highlight, true);
      document.addEventListener('click', finish, true);
      document.addEventListener('touchstart', block, true);
      document.addEventListener('pointerdown', block, true);
      window.__paseoMobileSelector = { destroy: destroy };
      return true;
    })();
  `;
}

export const MOBILE_BROWSER_PAGE_METADATA_SCRIPT = `
  (function() {
    var icon = document.querySelector('link[rel~="icon"]');
    var href = icon && icon.href ? icon.href : null;
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'paseo-page',
      title: document.title || '',
      faviconUrl: href
    }));
    return true;
  })();
`;
