// Single source of truth for default heading appearance, shared by the
// read-only renderer and the editable input so headings match across views.

export type HeadingLevelKey = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

export interface HeadingDefault {
  fontSize: number;
  color: string;
}

/** Default font weight applied to every heading level. */
export const DEFAULT_HEADING_FONT_WEIGHT = 'bold';

export const HEADING_DEFAULTS: Record<HeadingLevelKey, HeadingDefault> = {
  h1: { fontSize: 30, color: '#111827' },
  h2: { fontSize: 24, color: '#111827' },
  h3: { fontSize: 20, color: '#111827' },
  h4: { fontSize: 18, color: '#111827' },
  h5: { fontSize: 16, color: '#374151' },
  h6: { fontSize: 14, color: '#4B5563' },
};
