import { createContext } from "react";

// why: true only inside a chat dock whose viewport clips at the header edge, so a picker above the input can be cut from the top without measuring.
export const ComposerDockScope = createContext(false);
