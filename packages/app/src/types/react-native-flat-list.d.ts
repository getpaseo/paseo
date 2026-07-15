// React Native 0.81 implements FlatList's renderer memoization flag and ships
// it in generated types, but omits it from the legacy declarations exposed by
// the package entry point.
import "react-native";

declare module "react-native" {
  interface FlatListProps<ItemT> {
    strictMode?: boolean;
  }
}
