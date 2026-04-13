import { app, Menu, Tray, nativeImage, BrowserWindow } from "electron";
import * as path from "path";
import { DaemonManager, DaemonStatus } from "./daemon";

let tray: Tray | null = null;

const STATUS_LABELS: Record<DaemonStatus, string> = {
  stopped: "⏹ Stopped",
  starting: "🔄 Starting...",
  running: "✅ Running",
  error: "❌ Error",
};

export function createTray(
  mainWindow: BrowserWindow,
  daemon: DaemonManager
): Tray {
  const iconPath = path.join(__dirname, "..", "assets", "icon.png");
  // Create a tiny 16x16 fallback if icon doesn't exist
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("empty");
  } catch {
    // 16x16 transparent fallback
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("Flightdeck");

  const updateMenu = () => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: `Daemon: ${STATUS_LABELS[daemon.status]}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Show Window",
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      {
        label: "Restart Daemon",
        click: () => daemon.restart(),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]);
    tray?.setContextMenu(contextMenu);
  };

  updateMenu();
  daemon.on("status", updateMenu);

  tray.on("click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return tray;
}
