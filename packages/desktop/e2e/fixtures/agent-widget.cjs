const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", process.env.PASEO_WIDGET_TEST_HOME);
if (process.platform === "darwin") app.setActivationPolicy("regular");
app.whenReady().then(async () => {
  const {
    registerAgentWidget,
    widgetBounds,
  } = require("../../dist/features/agent-widget/index.js");
  const widget = registerAgentWidget();
  global.widgetBounds = widgetBounds;
  global.createWidgetOwner = async () => {
    const owner = new BrowserWindow({
      show: true,
      webPreferences: {
        preload: path.resolve(__dirname, "../../dist/preload.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    widget.attach(owner);
    await owner.loadURL(
      "data:text/html,<title>Widget owner fixture</title><p>Isolated widget integration test</p>",
    );
    return owner.id;
  };
  await global.createWidgetOwner();
  return undefined;
});
