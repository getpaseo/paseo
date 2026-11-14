import { createContext } from "react";
import type { MermaidDiagramOptions } from "@getpaseo/plugin/client/ui";

export const MermaidColorsContext = createContext<MermaidDiagramOptions | undefined>(undefined);
