import { registerStructuredOutput } from "./structured-output-plugin.mjs";
import { registerSharedBridge } from "./shared-bridge-plugin.mjs";

export default {
  id: "paseo",
  async setup(context) {
    const disposeStructuredOutput = await registerStructuredOutput(context);
    if (context.options.mode === "structured-only") return disposeStructuredOutput;
    const disposeBridge = await registerSharedBridge(context);
    return async () => {
      await disposeBridge();
      await disposeStructuredOutput();
    };
  },
};
