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
 * Native inline math: rendered as styled text since WebView cannot be nested
 * inside <Text> parents used by react-native-markdown-display.
 */
function InlineMath({ expression, theme }: { expression: string; theme: any }) {
  return (
    <Text
      style={{
        fontFamily: Fonts.mono,
        fontSize: theme.fontSize.sm,
        color: theme.colors.foreground,
      }}
    >
      {expression}
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
