import { injectStyleOnce } from './injectStyle';

export const ENRM_TEXT_CLASS = 'enrm-text';
export const ENRM_ADMONITION_CLASS = 'enrm-admonition';
export const ENRM_SELECTION_BG_VAR = '--enrm-selection-bg';

const RULES: ReadonlyArray<readonly [id: string, css: string]> = [
  [
    'enrm-selection-style',
    `.${ENRM_TEXT_CLASS} ::selection { background-color: var(${ENRM_SELECTION_BG_VAR}); }`,
  ],
  // Trim the trailing margin of a quote's last block so it doesn't add space
  // above the box's bottom padding, mirroring native. !important overrides the
  // per-element inline margin; the quote is a flex-item BFC so the margin can't
  // collapse out on its own.
  [
    'enrm-blockquote-trailing-margin',
    `.${ENRM_TEXT_CLASS} blockquote > *:last-child, ` +
      `.${ENRM_TEXT_CLASS} .${ENRM_ADMONITION_CLASS} > *:last-child { margin-bottom: 0 !important; }`,
  ],
];

for (const [id, css] of RULES) {
  injectStyleOnce(id, css);
}
