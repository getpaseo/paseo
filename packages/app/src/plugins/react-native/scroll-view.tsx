import { forwardRef } from "react";
import type {
  ScrollView as NativeScrollView,
  ScrollViewProps,
  FlatListProps,
  FlatList as NativeFlatList,
} from "react-native";
import type * as Shared from "@/components/ui/scroll-view";

// Plugin evaluation also runs before the native UI is ready. Load presentation
// dependencies at render time, as Modal does, rather than evaluating them on import.
export const ScrollView = forwardRef<NativeScrollView, ScrollViewProps>(
  function ScrollView(props, ref) {
    const { ScrollView: HostScrollView } =
      require("../../components/ui/scroll-view") as typeof Shared;
    return <HostScrollView {...props} ref={ref} />;
  },
);

export const FlatList = forwardRef<NativeFlatList<unknown>, FlatListProps<unknown>>(
  function FlatList(props, ref) {
    const { FlatList: HostFlatList } = require("../../components/ui/scroll-view") as typeof Shared;
    return <HostFlatList {...props} ref={ref} />;
  },
) as typeof Shared.FlatList;
