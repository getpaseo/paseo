import {
  WEB_SCROLLBAR_SIZE_PX,
  webScrollbarColor,
  webScrollbarThumbColor,
  WEB_SCROLLBAR_WIDTH,
} from "@/styles/web-scrollbar";

const STYLE_ID = "paseo-web-scrollbar-styles";

export function installWebScrollbarStyles(): () => void {
  const existingStyle = document.getElementById(STYLE_ID);
  if (existingStyle) return () => {};

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
* {
  scrollbar-color: ${webScrollbarColor("var(--colors-scrollbar-handle)")};
  scrollbar-width: ${WEB_SCROLLBAR_WIDTH};
}

[data-composer-input] {
  scrollbar-gutter: stable;
}

*::-webkit-scrollbar {
  width: ${WEB_SCROLLBAR_SIZE_PX}px;
  height: ${WEB_SCROLLBAR_SIZE_PX}px;
  background: transparent;
}

*::-webkit-scrollbar-track,
*::-webkit-scrollbar-corner {
  background: transparent;
}

*::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: ${webScrollbarThumbColor("var(--colors-scrollbar-handle)")};
  background-clip: content-box;
}
`;
  document.head.append(style);

  return () => style.remove();
}
