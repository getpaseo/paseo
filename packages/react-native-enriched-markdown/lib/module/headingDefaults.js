"use strict";

// Single source of truth for default heading appearance, shared by the
// read-only renderer and the editable input so headings match across views.

/** Default font weight applied to every heading level. */
export const DEFAULT_HEADING_FONT_WEIGHT = 'bold';
export const HEADING_DEFAULTS = {
  h1: {
    fontSize: 30,
    color: '#111827'
  },
  h2: {
    fontSize: 24,
    color: '#111827'
  },
  h3: {
    fontSize: 20,
    color: '#111827'
  },
  h4: {
    fontSize: 18,
    color: '#111827'
  },
  h5: {
    fontSize: 16,
    color: '#374151'
  },
  h6: {
    fontSize: 14,
    color: '#4B5563'
  }
};
//# sourceMappingURL=headingDefaults.js.map