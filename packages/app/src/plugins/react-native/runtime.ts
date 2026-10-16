import { Icon } from "../icons";
import { Modal } from "./modal";
import { Overlay } from "./overlay";
import { ScrollView, FlatList } from "./scroll-view";
import { TextInput } from "./text-input";
import { copyText } from "./clipboard";
import { pickFiles } from "./file-picker";
import { pickImages } from "./image-picker";
import { openImagePreview } from "./image-preview";
import { useToast } from "./toast";
import { useRevealedText } from "@/hooks/use-revealed-text";

export const pluginReactNativeRuntime = {
  Icon,
  Modal,
  Overlay,
  ScrollView,
  FlatList,
  TextInput,
  copyText,
  openImagePreview,
  pickFiles,
  pickImages,
  useRevealedText,
  useToast,
};
