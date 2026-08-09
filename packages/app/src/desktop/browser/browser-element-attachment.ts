import { buildWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import type { AttachmentMetadata, BrowserElementAttachment } from "@/attachments/types";

export type BrowserElementSelection = Omit<BrowserElementAttachment, "formatted" | "comment"> & {
  attributes?: Record<string, string>;
};

export interface BrowserElementAnnotation {
  comment: string;
}

export interface BrowserAnnotationMarker {
  index: number;
  selector: string;
}

export function truncateBrowserText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}

export function formatBrowserElementAttachment(
  selection: BrowserElementSelection,
  annotation?: BrowserElementAnnotation,
): string {
  const textPreview = truncateBrowserText(selection.text.trim(), 200);
  const html = truncateBrowserText(selection.outerHTML.trim(), 800);
  const parts: string[] = [];

  if (selection.reactSource?.fileName) {
    const location = [
      selection.reactSource.fileName,
      selection.reactSource.lineNumber != null ? `:${selection.reactSource.lineNumber}` : "",
      selection.reactSource.columnNumber != null ? `:${selection.reactSource.columnNumber}` : "",
    ].join("");
    parts.push(`source: ${selection.reactSource.componentName ?? selection.tag} @ ${location}`);
  }

  parts.push(`selector: ${selection.selector}`);
  if (textPreview) {
    parts.push(`text: ${JSON.stringify(textPreview)}`);
  }
  parts.push(`size: ${selection.boundingRect.width}x${selection.boundingRect.height}`);

  const keyStyles = Object.entries(selection.computedStyles)
    .filter(([key]) =>
      ["display", "position", "font-size", "color", "background-color"].includes(key),
    )
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
  if (keyStyles) {
    parts.push(`styles: ${keyStyles}`);
  }
  if (selection.parentChain.length > 0) {
    parts.push(`parents: ${selection.parentChain.slice(0, 3).join(" > ")}`);
  }

  const comment = annotation?.comment.trim();
  if (comment) {
    parts.push(`feedback: ${comment}`);
  }

  return [
    `<browser-element url="${selection.url}">`,
    parts.map((part) => `  ${part}`).join("\n"),
    `  html: ${html}`,
    `</browser-element>`,
  ].join("\n");
}

export function buildBrowserElementAttachment(
  selection: BrowserElementSelection,
  annotation?: BrowserElementAnnotation,
  screenshot?: AttachmentMetadata,
): BrowserElementAttachment {
  const comment = annotation?.comment.trim();
  return {
    url: selection.url,
    selector: selection.selector,
    tag: selection.tag,
    text: selection.text,
    outerHTML: truncateBrowserText(selection.outerHTML, 2000),
    computedStyles: selection.computedStyles,
    boundingRect: selection.boundingRect,
    reactSource: selection.reactSource,
    parentChain: selection.parentChain,
    children: selection.children,
    ...(comment ? { comment } : {}),
    ...(screenshot ? { screenshot } : {}),
    formatted: formatBrowserElementAttachment(selection, annotation),
  };
}

export function buildBrowserAttachmentScopeKey(input: {
  cwd: string | null;
  serverId: string;
  workspaceId: string;
}): string | null {
  const cwd = input.cwd;
  if (!cwd) {
    return null;
  }
  return buildWorkspaceAttachmentScopeKey({ ...input, cwd });
}

export function buildAnnotationMarkerScript(markers: readonly BrowserAnnotationMarker[]): string {
  const payload = JSON.stringify(markers);
  return `
    (function() {
      var markers = ${payload};
      if (window.__paseoAnnotationMarkers) { window.__paseoAnnotationMarkers.update(markers); return true; }
      var host = document.createElement('div');
      host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
      (document.body || document.documentElement).appendChild(host);
      var badges = [];
      var current = markers;
      function clearBadges() {
        for (var i = 0; i < badges.length; i++) { if (badges[i].parentNode) badges[i].parentNode.removeChild(badges[i]); }
        badges = [];
      }
      function reposition() {
        clearBadges();
        for (var i = 0; i < current.length; i++) {
          var marker = current[i];
          var element = null;
          try { element = document.querySelector(marker.selector); } catch (error) { element = null; }
          if (!element) continue;
          var rect = element.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          var badge = document.createElement('div');
          badge.textContent = String(marker.index);
          badge.style.cssText = 'position:fixed;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#2563eb;color:#fff;font:600 11px/18px -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.4);pointer-events:none;box-sizing:border-box;';
          badge.style.left = Math.max(0, rect.left) + 'px';
          badge.style.top = Math.max(0, rect.top) + 'px';
          host.appendChild(badge);
          badges.push(badge);
        }
      }
      var scheduled = false;
      function schedule() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(function() { scheduled = false; reposition(); });
      }
      window.addEventListener('scroll', schedule, true);
      window.addEventListener('resize', schedule, true);
      window.__paseoAnnotationMarkers = {
        update: function(next) { current = next; schedule(); },
        destroy: function() {
          window.removeEventListener('scroll', schedule, true);
          window.removeEventListener('resize', schedule, true);
          clearBadges();
          if (host.parentNode) host.parentNode.removeChild(host);
          window.__paseoAnnotationMarkers = null;
        }
      };
      reposition();
      return true;
    })();
  `;
}

export const CLEAR_ANNOTATION_MARKERS_SCRIPT =
  "if(window.__paseoAnnotationMarkers) window.__paseoAnnotationMarkers.destroy(); true;";
