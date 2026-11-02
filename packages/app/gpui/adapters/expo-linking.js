import { Linking } from "react-native";
import { NativeModule } from "expo-modules-core/src/polyfill/CoreModule";

class DesktopLinking extends NativeModule {
  initialURL = null;
  subscription;
  constructor() {
    super();
    Linking.getInitialURL()
      .then((url) => {
        this.initialURL = url;
        if (url) this.emit("onURLReceived", { url });
        return url;
      })
      .catch((error) => console.error("[GPUI linking]", error));
  }
  getLinkingURL = () => this.initialURL;
  clearInitialURL() {
    this.initialURL = null;
  }
  startObserving() {
    this.subscription = Linking.addEventListener("url", (event) =>
      this.emit("onURLReceived", event),
    );
  }
  stopObserving() {
    this.subscription?.remove();
  }
}
export default new DesktopLinking();
