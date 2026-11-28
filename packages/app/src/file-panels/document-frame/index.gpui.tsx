import { Text, View } from "react-native";

export function DocumentFrame({ url: _url, testID }: { url: string; testID?: string }) {
  return (
    <View testID={testID}>
      <Text>Document preview is not available in the GPUI build yet.</Text>
    </View>
  );
}
