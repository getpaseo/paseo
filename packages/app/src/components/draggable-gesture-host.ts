import { createContext } from "react";

/**
 * Whether the retained native gesture host around the draggable lists is presented. Every native
 * draggable list reads it to reattach its pan handler when the host reappears. Passing it as a prop
 * re-rendered each row between the sidebar and its nested lists whenever the dock was toggled.
 * Undefined means the lists are not inside a retained host.
 */
export const DraggableGestureHostPresentedContext = createContext<boolean | undefined>(undefined);
