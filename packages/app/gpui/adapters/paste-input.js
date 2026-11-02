// GPUI's native TextInput owns text paste, selection, and IME. The mobile
// PasteInput module's image-paste extension is not available on this target.
export { TextInput as default } from "react-native";
