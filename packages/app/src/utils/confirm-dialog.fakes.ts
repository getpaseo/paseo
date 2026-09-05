import type {
  DesktopDialogAskOptions,
  DesktopDialogAskWithCheckboxOptions,
  DesktopDialogAskWithCheckboxResult,
  DesktopDialogBridge,
} from "@/desktop/host";
import type {
  ConfirmDialogAlertRequest,
  ConfirmDialogHost,
  ConfirmDialogAlertButtonStyle,
} from "./confirm-dialog";

export interface RecordedDesktopAsk {
  message: string;
  options?: DesktopDialogAskOptions;
}

export interface RecordedDesktopAskWithCheckbox {
  message: string;
  options: DesktopDialogAskWithCheckboxOptions;
}

export interface FakeConfirmDialogHostOptions {
  isNative?: boolean;
  /** Which alert button the user presses; `undefined` dismisses the alert instead. */
  pressAlertButton?: string;
  desktopAsk?: (message: string, options?: DesktopDialogAskOptions) => boolean;
  desktopAskWithCheckbox?: (
    message: string,
    options: DesktopDialogAskWithCheckboxOptions,
  ) => DesktopDialogAskWithCheckboxResult;
  browserConfirm?: (message: string) => boolean;
}

export interface FakeConfirmDialogHost extends ConfirmDialogHost {
  readonly alerts: ConfirmDialogAlertRequest[];
  readonly desktopAsks: RecordedDesktopAsk[];
  readonly desktopAsksWithCheckbox: RecordedDesktopAskWithCheckbox[];
  readonly browserPrompts: string[];
  readonly blurCount: () => number;
  /** Button labels of the last alert, in the order the platform would render them. */
  lastAlertButtons(): Array<{ text: string; style: ConfirmDialogAlertButtonStyle }>;
}

/**
 * In-memory stand-in for the platform behind a confirmation. It records what each backend was
 * asked and replays the answer the test configured, so a test never has to stand in for React
 * Native, the desktop bridge, or `window`.
 */
export function createFakeConfirmDialogHost(
  options: FakeConfirmDialogHostOptions = {},
): FakeConfirmDialogHost {
  const alerts: ConfirmDialogAlertRequest[] = [];
  const desktopAsks: RecordedDesktopAsk[] = [];
  const desktopAsksWithCheckbox: RecordedDesktopAskWithCheckbox[] = [];
  const browserPrompts: string[] = [];
  let blurs = 0;

  const dialog: DesktopDialogBridge = {};
  if (options.desktopAsk) {
    const answer = options.desktopAsk;
    dialog.ask = async (message, askOptions) => {
      desktopAsks.push({ message, options: askOptions });
      return answer(message, askOptions);
    };
  }
  if (options.desktopAskWithCheckbox) {
    const answer = options.desktopAskWithCheckbox;
    dialog.askWithCheckbox = async (message, askOptions) => {
      desktopAsksWithCheckbox.push({ message, options: askOptions });
      return answer(message, askOptions);
    };
  }
  const hasDesktopDialog = Boolean(dialog.ask ?? dialog.askWithCheckbox);

  return {
    isNative: options.isNative ?? false,
    alerts,
    desktopAsks,
    desktopAsksWithCheckbox,
    browserPrompts,
    blurCount: () => blurs,

    lastAlertButtons() {
      const buttons = alerts[alerts.length - 1]?.buttons ?? [];
      return buttons.map((button) => ({ text: button.text, style: button.style }));
    },

    showAlert(request) {
      alerts.push(request);
      const pressed = request.buttons.find((button) => button.text === options.pressAlertButton);
      if (pressed) {
        pressed.onPress();
        return;
      }
      request.onDismiss();
    },

    getDesktopDialog() {
      return hasDesktopDialog ? dialog : null;
    },

    getBrowserConfirm() {
      const answer = options.browserConfirm;
      if (!answer) {
        return null;
      }
      return (message: string) => {
        browserPrompts.push(message);
        return answer(message);
      };
    },

    blurActiveElement() {
      blurs += 1;
    },
  };
}
