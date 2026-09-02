import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, collectMultiple } from "../../utils/command-options.js";
import {
  runBackCommand,
  runClickCommand,
  runCloseTabCommand,
  runDragCommand,
  runEvaluateCommand,
  runFillCommand,
  runForwardCommand,
  runHoverCommand,
  runKeypressCommand,
  runLogsCommand,
  runNavigateCommand,
  runNewTabCommand,
  runReloadCommand,
  runResizeCommand,
  runScreenshotCommand,
  runScrollCommand,
  runSelectCommand,
  runSnapshotCommand,
  runTabsCommand,
  runTypeCommand,
  runUploadCommand,
  runWaitCommand,
} from "./commands.js";

function addBrowserOptions(command: Command): Command {
  return addJsonAndDaemonHostOptions(command)
    .option("--cwd <path>", "Workspace directory that scopes the browser tab")
    .option("--workspace <workspace-id>", "Workspace id that scopes the browser tab");
}

export function createBrowserCommand(): Command {
  const browser = new Command("browser").description(
    "Drive Paseo browser tabs (same automation the browser_* agent tools use)",
  );

  addBrowserOptions(
    browser
      .command("new-tab")
      .description("Open a new Paseo browser tab")
      .argument("[url]", "http(s) URL to open"),
  ).action(withOutput(runNewTabCommand));

  addBrowserOptions(browser.command("tabs").description("List open Paseo browser tabs")).action(
    withOutput(runTabsCommand),
  );

  addBrowserOptions(
    browser
      .command("navigate")
      .description("Navigate a tab to a URL")
      .argument("<browser-id>", "Browser tab id")
      .argument("<url>", "http(s) URL to open"),
  ).action(withOutput(runNavigateCommand));

  addBrowserOptions(
    browser
      .command("click")
      .description("Click an element")
      .argument("<browser-id>", "Browser tab id")
      .argument("<ref>", "Element ref from `paseo browser snapshot` (for example @e12)")
      .option("--button <button>", "Mouse button: left, right or middle")
      .option("--double-click", "Send a double click")
      .option(
        "--modifiers <modifier>",
        "Modifier key held during the click (repeatable): Alt, Control, Meta, Shift",
        collectMultiple,
      ),
  ).action(withOutput(runClickCommand));

  addBrowserOptions(
    browser
      .command("fill")
      .description("Fill an input-like element")
      .argument("<browser-id>", "Browser tab id")
      .argument("<ref>", "Element ref from `paseo browser snapshot`")
      .argument("<value>", "Value to write"),
  ).action(withOutput(runFillCommand));

  addBrowserOptions(
    browser
      .command("type")
      .description("Type text into an element, or the focused element")
      .argument("<browser-id>", "Browser tab id")
      .argument("<text>", "Text to type")
      .option("--ref <ref>", "Element ref to focus before typing"),
  ).action(withOutput(runTypeCommand));

  addBrowserOptions(
    browser
      .command("select")
      .description("Set a select element to a value")
      .argument("<browser-id>", "Browser tab id")
      .argument("<ref>", "Element ref from `paseo browser snapshot`")
      .argument("<value>", "Option value to select"),
  ).action(withOutput(runSelectCommand));

  addBrowserOptions(
    browser
      .command("drag")
      .description("Drag one element onto another")
      .argument("<browser-id>", "Browser tab id")
      .argument("<source-ref>", "Element ref to drag")
      .argument("<target-ref>", "Element ref to drop onto"),
  ).action(withOutput(runDragCommand));

  addBrowserOptions(
    browser
      .command("hover")
      .description("Hover an element")
      .argument("<browser-id>", "Browser tab id")
      .argument("<ref>", "Element ref from `paseo browser snapshot`"),
  ).action(withOutput(runHoverCommand));

  addBrowserOptions(
    browser
      .command("keypress")
      .description("Dispatch a keypress to an element, or the focused element")
      .argument("<browser-id>", "Browser tab id")
      .argument("<key>", "Key name, for example Enter or ArrowDown")
      .option("--ref <ref>", "Element ref to focus before the keypress"),
  ).action(withOutput(runKeypressCommand));

  addBrowserOptions(
    browser
      .command("scroll")
      .description("Scroll a tab by CSS pixels")
      .argument("<browser-id>", "Browser tab id")
      .argument("<delta-x>", "Horizontal scroll delta")
      .argument("<delta-y>", "Vertical scroll delta")
      .option("--ref <ref>", "Element ref to center the wheel input over"),
  ).action(withOutput(runScrollCommand));

  addBrowserOptions(
    browser
      .command("upload")
      .description("Set files on a file input")
      .argument("<browser-id>", "Browser tab id")
      .argument("<ref>", "File input ref from `paseo browser snapshot`")
      .argument("<file...>", "Files to upload"),
  ).action(withOutput(runUploadCommand));

  addBrowserOptions(
    browser
      .command("evaluate")
      .description("Evaluate a JavaScript function in a tab")
      .argument("<browser-id>", "Browser tab id")
      .argument("<js-function>", "JavaScript function source, for example '() => document.title'")
      .option("--ref <ref>", "Element ref passed as the function's first argument"),
  ).action(withOutput(runEvaluateCommand));

  addBrowserOptions(
    browser
      .command("snapshot")
      .description("Capture a model-readable snapshot of a tab")
      .argument("<browser-id>", "Browser tab id"),
  ).action(withOutput(runSnapshotCommand));

  addBrowserOptions(
    browser
      .command("wait")
      .description("Wait until a tab contains text or reaches a URL fragment")
      .argument("<browser-id>", "Browser tab id")
      .option("--text <text>", "Text the page must contain")
      .option("--url <url>", "URL fragment the tab must reach")
      .option("--timeout <ms>", "Timeout in milliseconds (max 30000)"),
  ).action(withOutput(runWaitCommand));

  addBrowserOptions(
    browser
      .command("logs")
      .description("Read console messages and network entries for a tab")
      .argument("<browser-id>", "Browser tab id")
      .option("--max-entries <count>", "Maximum entries to return (max 200)"),
  ).action(withOutput(runLogsCommand));

  addBrowserOptions(
    browser
      .command("screenshot")
      .description("Capture a PNG screenshot of a tab")
      .argument("<browser-id>", "Browser tab id")
      .option("--full-page", "Capture the full page instead of the viewport")
      .option("--out <path>", "Write the PNG to this path"),
  ).action(withOutput(runScreenshotCommand));

  addBrowserOptions(
    browser
      .command("resize")
      .description("Resize a tab viewport")
      .argument("<browser-id>", "Browser tab id")
      .argument("<width>", "Viewport width in CSS pixels")
      .argument("<height>", "Viewport height in CSS pixels"),
  ).action(withOutput(runResizeCommand));

  addBrowserOptions(
    browser
      .command("reload")
      .description("Reload a tab")
      .argument("<browser-id>", "Browser tab id"),
  ).action(withOutput(runReloadCommand));

  addBrowserOptions(
    browser
      .command("back")
      .description("Go back in a tab")
      .argument("<browser-id>", "Browser tab id"),
  ).action(withOutput(runBackCommand));

  addBrowserOptions(
    browser
      .command("forward")
      .description("Go forward in a tab")
      .argument("<browser-id>", "Browser tab id"),
  ).action(withOutput(runForwardCommand));

  addBrowserOptions(
    browser
      .command("close-tab")
      .description("Close a Paseo browser tab")
      .argument("<browser-id>", "Browser tab id"),
  ).action(withOutput(runCloseTabCommand));

  return browser;
}
