import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("flightdeck", {
  getDaemonStatus: (): Promise<{
    status: string;
    port: number;
    url: string;
  }> => ipcRenderer.invoke("daemon:status"),

  getProjects: (): Promise<unknown[]> =>
    ipcRenderer.invoke("daemon:projects"),

  restartDaemon: (): Promise<void> =>
    ipcRenderer.invoke("daemon:restart"),

  onDaemonStatus: (callback: (status: string) => void) => {
    const handler = (_event: unknown, status: string) => callback(status);
    ipcRenderer.on("daemon:status-changed", handler);
    return () => ipcRenderer.removeListener("daemon:status-changed", handler);
  },

  onDaemonLog: (callback: (message: string) => void) => {
    const handler = (_event: unknown, message: string) => callback(message);
    ipcRenderer.on("daemon:log", handler);
    return () => ipcRenderer.removeListener("daemon:log", handler);
  },
});
