import { useMemo } from "react";
import NativeWebView from "react-native-webview";
import { StyleSheet } from "react-native-unistyles";
import { bytesToBase64 } from "@/components/workspace-file-previews/bytes";
import type { WorkspaceFilePreviewProps } from "@/components/workspace-file-previews/types";

const WEBVIEW_ORIGIN_WHITELIST = ["*"];

function buildDocxHtml(base64: string): string {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
body{margin:0;background:#fff;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#root{padding:12px;overflow:auto}
#state{padding:24px;color:#555;font-size:14px}
</style>
</head>
<body>
<div id="state">Loading document...</div>
<div id="root"></div>
<script src="https://unpkg.com/jszip@3.10.1/dist/jszip.min.js"></script>
<script src="https://unpkg.com/docx-preview@0.3.7/dist/docx-preview.min.js"></script>
<script>
function bytesFromBase64(value){const binary=atob(value);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;}
window.addEventListener('load',function(){
  const state=document.getElementById('state');
  const root=document.getElementById('root');
  const blob=new Blob([bytesFromBase64(${JSON.stringify(base64)})],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  window.docx.renderAsync(blob,root,undefined,{className:'paseo-docx-preview',inWrapper:true,ignoreFonts:true})
    .then(function(){state.remove();})
    .catch(function(error){state.textContent=error && error.message ? error.message : 'Failed to render document';});
});
</script>
</body>
</html>`;
}

export function WorkspaceDocxPreview({ bytes }: WorkspaceFilePreviewProps) {
  const html = useMemo(() => buildDocxHtml(bytesToBase64(bytes)), [bytes]);
  const source = useMemo(() => ({ html }), [html]);
  return (
    <NativeWebView
      originWhitelist={WEBVIEW_ORIGIN_WHITELIST}
      source={source}
      javaScriptEnabled
      domStorageEnabled
      style={styles.webview}
    />
  );
}

const styles = StyleSheet.create(() => ({
  webview: {
    flex: 1,
  },
}));
