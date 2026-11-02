import * as RN from "react-native";
import { createUnistylesElement } from "./unistyles";
export const View = createUnistylesElement(RN.View);
export const Text = createUnistylesElement(RN.Text);
export const ScrollView = createUnistylesElement(RN.ScrollView);
export const TextInput = createUnistylesElement(RN.TextInput);
export const Pressable = createUnistylesElement(RN.Pressable);
export const Image = createUnistylesElement(RN.Image);
export const ImageBackground = createUnistylesElement(RN.ImageBackground);
export const FlatList = createUnistylesElement(RN.FlatList);
export const SectionList = createUnistylesElement(RN.SectionList);
export const TouchableOpacity = createUnistylesElement(RN.TouchableOpacity);
export const TouchableHighlight = createUnistylesElement(RN.TouchableHighlight);
export const TouchableWithoutFeedback = createUnistylesElement(RN.TouchableWithoutFeedback);
export const ActivityIndicator = createUnistylesElement(RN.ActivityIndicator);
export const KeyboardAvoidingView = createUnistylesElement(RN.KeyboardAvoidingView);
export const SafeAreaView = createUnistylesElement(RN.SafeAreaView);
export const Switch = createUnistylesElement(RN.Switch);
export const StatusBar = RN.StatusBar;
export const Animated = {
  ...RN.Animated,
  View: createUnistylesElement(RN.Animated.View),
  Text: createUnistylesElement(RN.Animated.Text),
  ScrollView: createUnistylesElement(RN.Animated.ScrollView),
  Image: createUnistylesElement(RN.Animated.Image),
};
