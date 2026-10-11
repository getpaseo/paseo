import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../icons";
import { Modal } from "./modal";
import { ScrollView, FlatList } from "./scroll-view";
import { TextInput } from "./text-input";
import { copyText } from "./clipboard";
import { useToast } from "./toast";
import { useRevealedText } from "@/hooks/use-revealed-text";

export const pluginReactNativeRuntime = {
  Icon,
  Modal,
  ScrollView,
  FlatList,
  TextInput,
  copyText,
  useRevealedText,
  useSafeAreaInsets,
  useToast,
};
