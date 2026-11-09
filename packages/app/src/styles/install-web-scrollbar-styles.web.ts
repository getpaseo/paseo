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
  scrollbar-color: ${webScrollbarColor("var(--colors-foreground-extra-muted)")};
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
  background: ${webScrollbarThumbColor("var(--colors-foreground-extra-muted)")};
  background-clip: content-box;
}

*::-webkit-scrollbar-thumb:hover {
  background: ${webScrollbarThumbColor("var(--colors-foreground-muted)", 1)};
  background-clip: content-box;
}

[data-overlay-scrollbar="true"]::-webkit-scrollbar {
  display: none;
}
`;
  document.head.append(style);

  return () => style.remove();
}
