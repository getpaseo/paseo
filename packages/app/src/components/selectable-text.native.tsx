// On native (iOS + Android) we re-export `react-native-uitextview`'s
// UITextView. The library has its own `Platform.OS !== 'ios'` early return
// that yields the base RN Text on Android, so this also handles Android
// correctly without an extra guard here.
export { UITextView } from "react-native-uitextview";
