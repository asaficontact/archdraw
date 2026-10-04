// What the page may ask of the desktop: only to pick a folder. Everything else goes through the app's own HTTP API.

import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("archdraw", {
  desktop: true,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("archdraw:pick-folder"),
})
