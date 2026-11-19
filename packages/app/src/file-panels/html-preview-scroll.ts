// The preview is a sandboxed, opaque-origin frame: the parent cannot read its
// scroll offset, so the document reports it. Two facts make that necessary rather
// than optional. Switching Preview and Source recreates the frame, and a frame that
// has been hidden keeps its scroll offset but is repainted from a stale snapshot —
// the page looks like it jumped back to the top until something scrolls it again.
//
// The bridge therefore does three things, and nothing else: say where it is, go
// where it is told, and force one repaint after it lands. Like the CSP prologue it
// is our own markup, never the file's.
const MARKER = "paseoFilePreviewScroll";

const SCRIPT = `<script>(function(){var M="paseoFilePreviewScroll";var asked=false,raf=0,applying=false,started=Date.now();function y(){var d=document.documentElement;return Math.round(window.scrollY||(d&&d.scrollTop)||0);}function maxY(){var d=document.documentElement,b=document.body;var sh=Math.max((d&&d.scrollHeight)||0,(b&&b.scrollHeight)||0);return Math.max(0,sh-((d&&d.clientHeight)||window.innerHeight||0));}function post(k,v){try{var m={};m[M]=k;m.y=Math.round(v||0);if(window.ReactNativeWebView&&window.ReactNativeWebView.postMessage){window.ReactNativeWebView.postMessage(JSON.stringify(m));}else{parent.postMessage(m,"*");}}catch(e){}}function nudge(){applying=true;var d=document.documentElement;if(d){d.style.willChange="transform";void d.offsetHeight;d.style.willChange="";}applying=false;}var intent=0;function mark(){intent=Date.now();}window.addEventListener("wheel",mark,{passive:true});window.addEventListener("touchmove",mark,{passive:true});window.addEventListener("pointerdown",mark,{passive:true});window.addEventListener("keydown",mark,{});function onScroll(){if(applying)return;if(Date.now()-intent>1200)return;if(raf)return;raf=requestAnimationFrame(function(){raf=0;post("pos",y());});}window.addEventListener("scroll",onScroll,{passive:true});window.addEventListener("message",function(e){var d=e.data;if(!d||typeof d!=="object"||d[M]!=="restore"||typeof d.y!=="number")return;var want=d.y,start=Date.now();(function apply(){if(maxY()+4>=want){applying=true;window.scrollTo(0,want);applying=false;}if(Math.abs(y()-want)<=1||Date.now()-start>3000){nudge();post("pos",y());return;}setTimeout(apply,50);})();});function ask(){if(asked)return;var d=document.documentElement;var sh=Math.max((d&&d.scrollHeight)||0,(document.body&&document.body.scrollHeight)||0);if(sh<=0&&Date.now()-started<4000){setTimeout(ask,60);return;}asked=true;post("ask",y());}if(document.readyState==="complete"){ask();}else{window.addEventListener("load",ask);}setTimeout(ask,0);})();</script>`;

/** sha256 of the script body, so a document's own `script-src` can allow exactly it. */
const SCRIPT_HASH = "sha256-tgNkdxfaPeyOxeWpoGFOhVfhC1padohj3eyBDrr80Mg=";

const SCRIPT_BODY = SCRIPT.slice("<script>".length, -"</script>".length);

/** The directive that decides inline scripts here, and whether it already allows them. */
function scriptSources(policy: string): {
  status: "inline" | "listed" | "none";
  directive?: string;
} {
  const directives = policy.split(";").map((directive) => directive.trim());
  const byName = (name: string) =>
    directives.find((directive) => directive.toLowerCase().startsWith(`${name} `));
  const script = byName("script-src");
  const fallback = byName("default-src");
  const directive = script ?? fallback;
  if (!directive) return { status: "none" };
  if (/'unsafe-inline'/i.test(directive)) return { status: "inline" };
  // A `default-src` fallback is replaced rather than extended: the hash has to reach a
  // `script-src` directive for the browser to consider it for a script element.
  return script ? { status: "listed", directive: script } : { status: "none" };
}

const CSP_META = /<meta\b[^>]*\bhttp-equiv\s*=\s*(["']?)content-security-policy\1[^>]*>/gi;
const CONTENT_ATTRIBUTE = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i;

/**
 * Lets the bridge run inside a document that declares its own policy. Several
 * policies apply at once, so a file shipping `script-src 'sha256-…'` would otherwise
 * block our script; appending its hash adds exactly this one script and leaves the
 * rest of the file's policy alone.
 */
export function allowPreviewScrollBridge(document: string): string {
  return document.replace(CSP_META, (tag) => {
    const match = CONTENT_ATTRIBUTE.exec(tag);
    if (!match) return tag;
    const policy = match[2] ?? match[3] ?? "";
    // Our own prologue allows inline scripts, and adding a hash to a directive that
    // says `'unsafe-inline'` would make the browser ignore that permission — blocking
    // the file's own scripts instead of allowing ours. Only a document whose script
    // sources are enumerated (its own `script-src`, or a `default-src` fallback with
    // no `'unsafe-inline'`) needs the hash.
    const sources = scriptSources(policy);
    if (sources.status === "inline") return tag;
    const directive = sources.directive;
    const next =
      directive !== undefined
        ? policy.replace(directive, `${directive} '${SCRIPT_HASH}'`)
        : `${policy}; script-src '${SCRIPT_HASH}'`;
    return tag.replace(match[0], `content="${next}"`);
  });
}

/** The bridge, appended after the file's own markup so its scripts run first. */
export function withPreviewScrollBridge(document: string): string {
  return allowPreviewScrollBridge(document) + SCRIPT;
}

export { MARKER as PREVIEW_SCROLL_MARKER };

/** The element the bridge is appended as; exported for the append test. */
export const PREVIEW_SCROLL_SCRIPT = SCRIPT;

/** The hash a document's own policy has to allow; exported for the drift test. */
export const PREVIEW_SCROLL_SCRIPT_HASH = SCRIPT_HASH;

export { SCRIPT_BODY as PREVIEW_SCROLL_SCRIPT_BODY };
