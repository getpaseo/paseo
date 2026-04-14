import { useMemo, useState, useCallback, useRef } from "react";
import { Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { WebView } from "react-native-webview";
import { Fonts } from "@/constants/theme";

export interface MathViewProps {
  expression: string;
  displayMode: boolean;
}

const HEIGHT_SCRIPT = `
(function(){
  var last=0;
  function send(){
    var s=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);
    var r=document.body.getBoundingClientRect().height;
    var h=Math.ceil(Math.max(s,r));
    if(h>0&&Math.abs(h-last)>2){
      last=h;
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'height',height:h}));
    }
  }
  if(typeof ResizeObserver!=='undefined'){
    new ResizeObserver(send).observe(document.body);
  }
  send();
  setTimeout(send,100);
  setTimeout(send,300);
  setTimeout(send,800);
  setTimeout(send,1500);
  if(document.fonts&&document.fonts.ready){
    document.fonts.ready.then(function(){send();setTimeout(send,100);});
  }
})();
true;
`;

function buildHtml(expression: string, textColor: string, displayMode: boolean): string {
  const delimiter = displayMode ? "$$" : "$";
  const content = `${delimiter}${expression}${delimiter}`;
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css" crossorigin="anonymous">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js" crossorigin="anonymous"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.min.js" crossorigin="anonymous"></script>
<style>
*{margin:0;padding:0;}
body{background:transparent;color:${textColor};padding:4px 8px;font-size:16px;text-align:${displayMode ? "center" : "left"};}
.katex-display{overflow-x:auto;overflow-y:visible;margin:0 !important;}
.katex{font-size:1.1em;}
</style>
<script>
document.addEventListener("DOMContentLoaded",function(){
  renderMathInElement(document.body,{
    delimiters:[
      {left:"$$",right:"$$",display:true},
      {left:"$",right:"$",display:false}
    ],
    throwOnError:false
  });
});
</script>
</head>
<body>${content}</body>
</html>`;
}

/**
 * Convert LaTeX to approximate Unicode text for native inline rendering.
 * Handles common math notations; complex expressions fall back to source.
 */
function latexToUnicode(tex: string): string {
  let s = tex.trim();

  // Greek letters
  const greek: Record<string, string> = {
    alpha: "\u03B1",
    beta: "\u03B2",
    gamma: "\u03B3",
    delta: "\u03B4",
    epsilon: "\u03B5",
    zeta: "\u03B6",
    eta: "\u03B7",
    theta: "\u03B8",
    iota: "\u03B9",
    kappa: "\u03BA",
    lambda: "\u03BB",
    mu: "\u03BC",
    nu: "\u03BD",
    xi: "\u03BE",
    pi: "\u03C0",
    rho: "\u03C1",
    sigma: "\u03C3",
    tau: "\u03C4",
    upsilon: "\u03C5",
    phi: "\u03C6",
    chi: "\u03C7",
    psi: "\u03C8",
    omega: "\u03C9",
    Gamma: "\u0393",
    Delta: "\u0394",
    Theta: "\u0398",
    Lambda: "\u039B",
    Xi: "\u039E",
    Pi: "\u03A0",
    Sigma: "\u03A3",
    Phi: "\u03A6",
    Psi: "\u03A8",
    Omega: "\u03A9",
  };

  // Operators and symbols
  const symbols: Record<string, string> = {
    times: "\u00D7",
    div: "\u00F7",
    cdot: "\u00B7",
    cdots: "\u22EF",
    ldots: "\u2026",
    pm: "\u00B1",
    mp: "\u2213",
    leq: "\u2264",
    le: "\u2264",
    geq: "\u2265",
    ge: "\u2265",
    neq: "\u2260",
    ne: "\u2260",
    approx: "\u2248",
    equiv: "\u2261",
    sim: "\u223C",
    propto: "\u221D",
    infty: "\u221E",
    partial: "\u2202",
    nabla: "\u2207",
    forall: "\u2200",
    exists: "\u2203",
    in: "\u2208",
    notin: "\u2209",
    subset: "\u2282",
    supset: "\u2283",
    cup: "\u222A",
    cap: "\u2229",
    emptyset: "\u2205",
    neg: "\u00AC",
    land: "\u2227",
    lor: "\u2228",
    to: "\u2192",
    rightarrow: "\u2192",
    leftarrow: "\u2190",
    Rightarrow: "\u21D2",
    Leftarrow: "\u21D0",
    leftrightarrow: "\u2194",
    iff: "\u21D4",
    sum: "\u2211",
    prod: "\u220F",
    int: "\u222B",
    iint: "\u222C",
    oint: "\u222E",
    langle: "\u27E8",
    rangle: "\u27E9",
    lceil: "\u2308",
    rceil: "\u2309",
    lfloor: "\u230A",
    rfloor: "\u230B",
    star: "\u22C6",
    circ: "\u2218",
    bullet: "\u2022",
    diamond: "\u22C4",
    triangle: "\u25B3",
    perp: "\u22A5",
    parallel: "\u2225",
    angle: "\u2220",
    degree: "\u00B0",
    prime: "\u2032",
  };

  // Superscript digits and letters
  const supMap: Record<string, string> = {
    "0": "\u2070",
    "1": "\u00B9",
    "2": "\u00B2",
    "3": "\u00B3",
    "4": "\u2074",
    "5": "\u2075",
    "6": "\u2076",
    "7": "\u2077",
    "8": "\u2078",
    "9": "\u2079",
    "+": "\u207A",
    "-": "\u207B",
    n: "\u207F",
    i: "\u2071",
    "(": "\u207D",
    ")": "\u207E",
  };

  // Subscript digits
  const subMap: Record<string, string> = {
    "0": "\u2080",
    "1": "\u2081",
    "2": "\u2082",
    "3": "\u2083",
    "4": "\u2084",
    "5": "\u2085",
    "6": "\u2086",
    "7": "\u2087",
    "8": "\u2088",
    "9": "\u2089",
    "+": "\u208A",
    "-": "\u208B",
    a: "\u2090",
    e: "\u2091",
    i: "\u1D62",
    o: "\u2092",
    x: "\u2093",
    k: "\u2096",
    n: "\u2099",
    "(": "\u208D",
    ")": "\u208E",
  };

  function toSup(content: string): string {
    return content
      .split("")
      .map((c) => supMap[c] ?? c)
      .join("");
  }

  function toSub(content: string): string {
    return content
      .split("")
      .map((c) => subMap[c] ?? c)
      .join("");
  }

  // Extract braced group: returns content and rest of string
  function parseBraced(str: string): [string, string] {
    if (str.startsWith("{")) {
      let depth = 0;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === "{") depth++;
        else if (str[i] === "}") {
          depth--;
          if (depth === 0) return [str.slice(1, i), str.slice(i + 1)];
        }
      }
      return [str.slice(1), ""];
    }
    // Single character (no braces)
    if (str.length > 0) return [str[0], str.slice(1)];
    return ["", ""];
  }

  // Process \frac{a}{b} → a/b
  s = s.replace(/\\frac\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (_, a, b) => {
    const aa = latexToUnicode(a);
    const bb = latexToUnicode(b);
    return `(${aa})/(${bb})`;
  });

  // Process \sqrt[n]{x} → ⁿ√x and \sqrt{x} → √x
  s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^}]*)\}/g, (_, n, x) => {
    return `${toSup(n)}\u221A(${latexToUnicode(x)})`;
  });
  s = s.replace(/\\sqrt\s*\{([^}]*)\}/g, (_, x) => `\u221A(${latexToUnicode(x)})`);

  // Process \text{...} and \mathrm{...} and \textbf{...}
  s = s.replace(/\\(?:text|mathrm|textbf|mathbf|mathit|textit|operatorname)\s*\{([^}]*)\}/g, "$1");

  // Function names: \sin, \cos, \tan, \log, \ln, \exp, \lim, \max, \min, etc.
  s = s.replace(
    /\\(sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|log|ln|exp|lim|max|min|sup|inf|det|dim|ker|deg|arg|gcd|mod)\b/g,
    "$1",
  );

  // Process \left and \right (just remove them)
  s = s.replace(/\\left\s*/g, "");
  s = s.replace(/\\right\s*/g, "");

  // Process \bar{x} → x̄, \hat{x} → x̂, \vec{x} → x⃗, \dot{x} → ẋ, \tilde{x} → x̃
  s = s.replace(/\\bar\s*\{([^}]*)\}/g, "$1\u0304");
  s = s.replace(/\\hat\s*\{([^}]*)\}/g, "$1\u0302");
  s = s.replace(/\\vec\s*\{([^}]*)\}/g, "$1\u20D7");
  s = s.replace(/\\dot\s*\{([^}]*)\}/g, "$1\u0307");
  s = s.replace(/\\ddot\s*\{([^}]*)\}/g, "$1\u0308");
  s = s.replace(/\\tilde\s*\{([^}]*)\}/g, "$1\u0303");

  // Replace Greek letters and symbols: \alpha → α, etc.
  s = s.replace(/\\([a-zA-Z]+)/g, (_, name) => {
    if (greek[name]) return greek[name];
    if (symbols[name]) return symbols[name];
    return name;
  });

  // Process superscripts: ^{...} or ^x
  s = s.replace(/\^(\{[^}]*\}|[a-zA-Z0-9+\-])/g, (_, g) => {
    const content = g.startsWith("{") ? g.slice(1, -1) : g;
    return toSup(content);
  });

  // Process subscripts: _{...} or _x
  s = s.replace(/_(\{[^}]*\}|[a-zA-Z0-9+\-])/g, (_, g) => {
    const content = g.startsWith("{") ? g.slice(1, -1) : g;
    return toSub(content);
  });

  // Clean up remaining braces and spacing commands
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\\[,;:!]\s*/g, " ");
  s = s.replace(/\\\s/g, " ");
  s = s.replace(/\s+/g, " ");

  return s.trim();
}

/**
 * Native inline math: LaTeX converted to Unicode approximation.
 */
function InlineMath({ expression, theme }: { expression: string; theme: any }) {
  const display = useMemo(() => latexToUnicode(expression), [expression]);
  return (
    <Text
      style={{
        fontSize: theme.fontSize.base,
        color: theme.colors.foreground,
      }}
    >
      {display}
    </Text>
  );
}

/**
 * Native block math: WebView with KaTeX loaded from CDN via auto-render.
 */
function BlockMath({ expression, theme }: { expression: string; theme: any }) {
  const [height, setHeight] = useState(80);
  const lastHeightRef = useRef(80);

  const html = useMemo(
    () => buildHtml(expression, theme.colors.foreground, true),
    [expression, theme.colors.foreground],
  );

  const handleMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "height" && typeof data.height === "number" && data.height > 0) {
        const newHeight = Math.max(data.height, 30);
        if (Math.abs(newHeight - lastHeightRef.current) > 2) {
          lastHeightRef.current = newHeight;
          setHeight(newHeight);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  return (
    <View style={{ width: "100%", height, overflow: "hidden", marginVertical: theme.spacing[2] }}>
      <WebView
        source={{ html }}
        injectedJavaScript={HEIGHT_SCRIPT}
        onMessage={handleMessage}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        originWhitelist={["*"]}
        javaScriptEnabled={true}
        style={{ backgroundColor: "transparent" }}
        opaque={false}
        androidLayerType="software"
      />
    </View>
  );
}

export function MathView({ expression, displayMode }: MathViewProps) {
  const { theme } = useUnistyles();

  if (displayMode) {
    return <BlockMath expression={expression} theme={theme} />;
  }

  return <InlineMath expression={expression} theme={theme} />;
}
