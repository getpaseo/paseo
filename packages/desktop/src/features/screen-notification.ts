import { BrowserWindow, screen } from "electron";
import { NOTIFICATION_ICON_BASE64 } from "./notification-icon-data.js";

interface ScreenNotificationOptions {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  onOpenTarget?: (data?: Record<string, unknown>) => void;
}

let activeNotificationWindow: BrowserWindow | null = null;
let dismissTimer: NodeJS.Timeout | null = null;

export function showScreenFloatingNotification(options: ScreenNotificationOptions): void {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;

  const width = 380;
  const height = 100;
  const margin = 16;

  // Position at bottom-right corner of the main display (above the taskbar)
  const x = workArea.x + workArea.width - width - margin;
  const y = workArea.y + workArea.height - height - margin;

  if (activeNotificationWindow && !activeNotificationWindow.isDestroyed()) {
    try {
      activeNotificationWindow.close();
    } catch {
      // Ignored
    }
  }

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  activeNotificationWindow = win;

  const escapedTitle = escapeHtml(options.title);
  const escapedBody = options.body ? escapeHtml(options.body) : "";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: transparent !important;
      margin: 0;
      padding: 0;
    }
    .card {
      background: #1E2120;
      border: 1px solid #252B2A;
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      gap: 6px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.6);
      cursor: pointer;
      color: #ffffff;
      width: 100%;
      height: 100%;
      position: relative;
      animation: slideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      transition: background 0.15s, border-color 0.15s;
    }
    .card:hover {
      background: #272A29;
      border-color: #2F3534;
    }
    @keyframes slideIn {
      from { transform: translateX(36px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
    }
    .app-brand {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .app-icon {
      width: 16px;
      height: 16px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .app-name {
      font-size: 11.5px;
      font-weight: 600;
      color: #ffffff;
      letter-spacing: 0.1px;
    }
    .dot {
      font-size: 10px;
      color: #717574;
    }
    .time-badge {
      font-size: 10.5px;
      color: #717574;
    }
    .close {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #717574;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: color 0.15s, background 0.15s;
    }
    .close:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.12);
    }
    .content {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .title {
      font-size: 13px;
      font-weight: 600;
      color: #ffffff;
      line-height: 17px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .body {
      font-size: 12px;
      color: #A1A5A4;
      line-height: 15px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="top-bar">
      <div class="app-brand">
        <img src="${NOTIFICATION_ICON_BASE64}" class="app-icon" alt="Paseo">
        <span class="app-name">Paseo</span>
        <span class="dot">•</span>
        <span class="time-badge">agora</span>
      </div>
      <div class="close" id="close" title="Fechar">✕</div>
    </div>
    <div class="content">
      <div class="title">${escapedTitle}</div>
      ${escapedBody ? `<div class="body">${escapedBody}</div>` : ""}
    </div>
  </div>
  <script>
    const card = document.getElementById('card');
    const close = document.getElementById('close');

    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.href = 'paseo-action://close';
    });

    card.addEventListener('click', () => {
      window.location.href = 'paseo-action://click';
    });

    card.addEventListener('mouseenter', () => {
      window.location.href = 'paseo-action://pause';
    });

    card.addEventListener('mouseleave', () => {
      window.location.href = 'paseo-action://resume';
    });
  </script>
</body>
</html>`;

  // Intercept actions natively without depending on dom-ready or console-message timing
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url.startsWith("paseo-action://click")) {
      if (options.onOpenTarget) {
        options.onOpenTarget(options.data);
      }
      if (!win.isDestroyed()) {
        win.close();
      }
    } else if (url.startsWith("paseo-action://close")) {
      if (!win.isDestroyed()) {
        win.close();
      }
    } else if (url.startsWith("paseo-action://pause")) {
      if (dismissTimer) {
        clearTimeout(dismissTimer);
        dismissTimer = null;
      }
    } else if (url.startsWith("paseo-action://resume")) {
      if (!dismissTimer && !win.isDestroyed()) {
        dismissTimer = setTimeout(() => {
          if (!win.isDestroyed()) {
            win.close();
          }
        }, 5000);
      }
    }
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.showInactive();
    }
  });

  if (dismissTimer) {
    clearTimeout(dismissTimer);
  }

  dismissTimer = setTimeout(() => {
    if (!win.isDestroyed()) {
      win.close();
    }
  }, 5000);

  win.on("closed", () => {
    if (activeNotificationWindow === win) {
      activeNotificationWindow = null;
    }
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
