// Web dialogs use ordinary scrolling at every breakpoint. Keep native gesture
// dependencies out of this module's import graph.
export { ScrollView, FlatList } from "react-native";

/** A web drag reads pointer events and never competes with the page scroll, so a scroll view needs nothing to host it. */
export function withContentDrag<C>(Scroll: C): C {
  return Scroll;
}
