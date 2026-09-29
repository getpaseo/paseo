import { Asset } from "expo-asset";

// PandaOS type: Instrument Sans (interface), Instrument Serif (titles), JetBrains Mono (numbers
// and code). Registered with explicit weights; loading them by family alone would leave 500/600
// to synthetic bolding.
const FACES: readonly [family: string, weight: number, module: number][] = [
  ["Instrument Sans", 400, require("../../assets/fonts/InstrumentSans-400.ttf")],
  ["Instrument Sans", 500, require("../../assets/fonts/InstrumentSans-500.ttf")],
  ["Instrument Sans", 600, require("../../assets/fonts/InstrumentSans-600.ttf")],
  ["Instrument Serif", 400, require("../../assets/fonts/InstrumentSerif-400.ttf")],
  ["JetBrains Mono", 400, require("../../assets/fonts/JetBrainsMono-400.ttf")],
  ["JetBrains Mono", 500, require("../../assets/fonts/JetBrainsMono-500.ttf")],
];

const STYLE_ID = "pandaos-bundled-fonts";

export function registerBundledFonts(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = FACES.map(
    ([family, weight, module]) =>
      `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;` +
      `src:url("${Asset.fromModule(module).uri}") format("truetype");}`,
  ).join("");
  document.head.appendChild(style);
}
