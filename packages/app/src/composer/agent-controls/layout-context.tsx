import { createContext, useContext, type ReactNode } from "react";
import { toolbarGlyphsFor, type ToolbarGlyphs } from "@/components/ui/control-geometry";
import {
  resolveComposerControlPresentation,
  type ComposerControlPresentation,
} from "@/composer/agent-controls/layout";

interface ComposerControlLayoutValue {
  glyphs: ToolbarGlyphs;
  presentation: ComposerControlPresentation;
}

const DEFAULT_LAYOUT: ComposerControlLayoutValue = {
  glyphs: toolbarGlyphsFor("pointer"),
  presentation: resolveComposerControlPresentation("full"),
};

const ComposerControlLayoutContext = createContext(DEFAULT_LAYOUT);

export function ComposerControlLayoutProvider({
  value,
  children,
}: {
  value: ComposerControlLayoutValue;
  children: ReactNode;
}) {
  return (
    <ComposerControlLayoutContext.Provider value={value}>
      {children}
    </ComposerControlLayoutContext.Provider>
  );
}

export function useComposerControlLayout(): ComposerControlLayoutValue {
  return useContext(ComposerControlLayoutContext);
}
