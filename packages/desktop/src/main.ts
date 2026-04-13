import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import * as http from "http";
import { DaemonManager } from "./daemon";
import { createTray } from "./tray";

let mainWindow: BrowserWindow | null = null;
const daemon = new DaemonManager();
let isQuitting = false;

function createWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, "preload.js");

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Flightdeck",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  // Show when ready to avoid flash
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Minimize to tray instead of closing
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  return mainWindow;
}

function loadUI() {
  if (!mainWindow) return;

  // In dev, the web UI dist is at packages/web/dist
  // In production (packaged), it's in resources/web
  const webDistPath = app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.join(__dirname, "..", "..", "web", "dist");

  // Load via the daemon URL so API calls work (same origin)
  mainWindow.loadURL(`${daemon.url}`).catch(() => {
    // Fallback: load local files with a splash message
    mainWindow?.loadURL(
      `data:text/html,<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#0a0a0a;color:#fff"><div style="text-align:center"><h1>🚀 Flightdeck</h1><p>Starting daemon...</p><p style="color:#666">${daemon.status}</p></div></body></html>`
    );
  });
}

function setupIPC() {
  ipcMain.handle("daemon:status", () => ({
    status: daemon.status,
    port: daemon.port,
    url: daemon.url,
  }));

  ipcMain.handle("daemon:projects", async () => {
    try {
      return await fetchJSON(`${daemon.url}/api/projects`);
    } catch {
      return [];
    }
  });

  ipcMain.handle("daemon:restart", async () => {
    await daemon.restart();
  });

  // Forward daemon events to renderer
  daemon.on("status", (status) => {
    mainWindow?.webContents.send("daemon:status-changed", status);
    if (status === "running") {
      loadUI();
    }
  });

  daemon.on("log", (message) => {
    mainWindow?.webContents.send("daemon:log", message);
  });
}

function fetchJSON(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { timeout: 5000 }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", reject);
  });
}

app.whenReady().then(async () => {
  const win = createWindow();
  setupIPC();
  createTray(win, daemon);

  // Show loading screen immediately
  win.loadURL(
    `data:text/html,<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#0a0a0a;color:#fff"><div style="text-align:center"><h1>🚀 Flightdeck</h1><p>Starting daemon...</p></div></body></html>`
  );
  win.show();

  // Start daemon, then load real UI
  await daemon.start();
  if (daemon.status === "running") {
    loadUI();
  }
});

app.on("before-quit", async () => {
  isQuitting = true;
  await daemon.stop();
});

app.on("window-all-closed", () => {
  // On macOS, keep app running in tray
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // macOS dock click
  mainWindow?.show();
});
