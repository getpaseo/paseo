/**
 * Native does not use Unistyles' web CSS registry, and native Unistyles treats
 * any `unistyles_*` key as a registered style hash. The web marker would crash
 * native ref binding, so native keeps these dynamic styles as plain RN styles.
 */
export function inlineUnistylesStyle<TStyle extends object>(style: TStyle): TStyle {
  return style;
}
