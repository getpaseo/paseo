import { Icon } from "../icons";
import { Modal } from "./modal";
import { ScrollView, FlatList } from "./scroll-view";
import { TextInput } from "./text-input";
import { copyText } from "./clipboard";
import { useToast } from "./toast";
import { useRevealedText } from "@/hooks/use-revealed-text";
import { MarkdownRenderer } from "@/components/markdown/renderer";

export const pluginReactNativeRuntime = {
  Markdown: MarkdownRenderer,
  Icon,
  Modal,
  ScrollView,
  FlatList,
  TextInput,
  copyText,
  useRevealedText,
  useToast,
} satisfies typeof import("@getpaseo/plugin/client/react-native");
