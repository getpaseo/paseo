# 浏览器截图验证套件

桌面截图验证套件是针对浏览器截图的真实 Electron 验证路径。它验证单元测试无法看到的合成器行为：

- 常驻自动化 `<webview>` 在生产停放状态下启动；
- 停放中的访客保持可绘制并具有可复制的视口帧；
- 常驻 webview 访客尺寸为 1280x800 逻辑像素；
- 多个常驻 webview 作为重叠堆栈停放，无需每次截图时改变堆叠；
- 新附加的常驻 webview 其第一个有效帧延迟到达时，可以通过重试直到帧出现来完成截图；
- 视口 `capturePage` 和全页 CDP 截图都从永久生产停放状态返回真实像素；
- 访客后台限流可以在附加时一次性禁用，无需每次截图进行渲染器协调。

使用仓库中的 Electron 运行：

```bash
npm run capture-harness --workspace=@getpaseo/desktop
```

使用浏览器自动化装置运行：

```bash
PASEO_CAPTURE_HARNESS_GROUP=automation npm run capture-harness --workspace=@getpaseo/desktop
```

自动化组使用真实的访客 webview 来验证页面端引用约定：类 ARIA 快照文本包含标题、静态文本和控件；当元素仍然匹配时，引用在 `pushState` 后存活；相同 URL 的重渲染使旧引用失效；文件输入引用可以解析为 CDP 后端节点 ID 用于上传。它还验证页面上下文求值，包括将解析后的引用元素作为函数参数传递。

在 macOS 上，套件进程必须在创建任何窗口之前设置 `app.setActivationPolicy("accessory")` 并隐藏 Dock 图标。`showInactive()` 仅阻止窗口获取焦点；正常的 Electron 应用启动仍可能激活应用并抢占焦点。套件窗口随后以隐藏方式创建，定位在屏幕角落，在 Electron 支持的情况下从任务栏中跳过，并在 `ready-to-show` 时通过 `showInactive()` 显示。不要将其替换为 `show()`、`focus()` 或 `app.focus()`：合成器只需要可见的非活跃窗口，套件运行不得抢占使用计算机的人的焦点。

套件将 PNG 证据和 `results.json` 写入：

```text
packages/desktop/capture-harness/out/
```

通过的运行会为生产 P1 附加-停放状态打印 `PASS` 行，包括全新、稳定后、75 秒浸泡、多标签、视口和全页检查。PNG 尺寸可能按设备像素缩放；在 Retina 显示屏上，1280x800 逻辑视口通常保存为 2560x1600。

## 机制

Electron 截图从访客 web 内容的合成器表面复制。以 `display:none`、屏幕外坐标或 `opacity:0` 停放的常驻 webview 可能失去其可复制的表面。生产停放状态将宿主固定在 `left:0`、`top:0`、`width:1px`、`height:1px`、`overflow:hidden`、`opacity:1` 和 `pointer-events:none`。内部的 webview 保持全尺寸 1280x800、`display:inline-flex`，并在 `left:0`、`top:0` 处绝对重叠。

没有渲染器准备/恢复握手。主进程在 webview 附加时一次性禁用访客后台限流，然后截图使用共享的序列化队列，在每次尝试前使其失效，并在 5 秒截图预算内重试已知的首帧失败。视口截图使用 `capturePage({ stayHidden:false })`；全页截图使用现有的 CDP 路径，包含布局指标和截图裁剪。
