// archdraw for the desktop (macOS and Linux; Windows later). The window shows the same UI as the trex deployment:
// this process runs the same server (server/src/main.ts `start`) on 127.0.0.1 with a per-launch token, and opens the
// window at /?token=<token> (the server turns it into an HttpOnly cookie). Keys are encrypted with the OS keychain
// (safeStorage); the app's state lives in userData; the hourly sync keeps running from the tray when the window closes.

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron"
import { start } from "../../server/src/main.js"
import { SafeKeys } from "./keys.js"

const dev = !app.isPackaged
const res = (p: string) => (dev ? join(import.meta.dirname, "..", "..", p) : join(process.resourcesPath, p))

// a GUI app on macOS starts with a bare PATH; git and gh usually live in Homebrew's or /usr/local's bin
if (process.platform === "darwin") process.env.PATH = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":")
process.env.ARCHDRAW_ASSETS = dev ? res("core/assets") : res("assets")

let win: BrowserWindow | null = null
let tray: Tray | null = null
let server: Awaited<ReturnType<typeof start>> | null = null
let quitting = false
const token = randomBytes(24).toString("hex")

if (!app.requestSingleInstanceLock()) app.quit()
app.on("second-instance", () => show())

function icon(): Electron.NativeImage {
  const file = dev ? res("desktop/icon.png") : res("icon.png")
  return existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty()
}

function show() {
  if (!win || win.isDestroyed()) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 860,
    minHeight: 560,
    title: "archdraw",
    icon: icon(),
    backgroundColor: "#f6f7f9",
    show: false,
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  })
  win.once("ready-to-show", () => win?.show())
  // the window shows only the app: links elsewhere open in the browser, navigation away is refused
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(server!.url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(server!.url)) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })
  // closing the window keeps archdraw in the tray (Linux) or the dock (macOS), so the hourly check goes on
  win.on("close", e => {
    if (!quitting && (tray || process.platform === "darwin")) {
      e.preventDefault()
      win?.hide()
    }
  })
  void win.loadURL(`${server!.url}/?token=${token}`)
}

function menu() {
  const tour = () => win?.webContents.executeJavaScript(`window.dispatchEvent(new Event("archdraw:tour"))`)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          { label: "Show me around", click: () => (show(), void tour()) },
          { label: "Open the data folder", click: () => void shell.openPath(app.getPath("userData")) },
        ],
      },
    ]),
  )
}

function makeTray() {
  if (process.platform === "darwin") return // the dock icon is the way back on macOS
  try {
    tray = new Tray(icon().resize({ width: 22, height: 22 }))
    tray.setToolTip("archdraw")
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open archdraw", click: () => show() },
        { type: "separator" },
        { label: "Quit", click: () => ((quitting = true), app.quit()) },
      ]),
    )
    tray.on("click", () => show())
  } catch {
    tray = null // no tray on this desktop: closing the window quits
  }
}

ipcMain.handle("archdraw:pick-folder", async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "Choose a project folder" })
  return r.canceled ? null : r.filePaths[0]
})

app.whenReady().then(async () => {
  const keys = new SafeKeys(join(app.getPath("userData"), "keys.json"))
  server = await start({
    home: app.getPath("userData"),
    host: "127.0.0.1",
    port: 0,
    gate: { mode: "token", token },
    keys,
    ui: dev ? res("ui/dist") : res("ui"),
    sync: true,
    by: "archdraw",
    log: s => dev && console.log(s),
  })
  menu()
  makeTray()
  createWindow()
  if (keys.weak) void dialog.showMessageBox({ type: "warning", message: "No system keychain found", detail: "Your AI key will be stored on this machine with only basic protection. Install a keyring (GNOME Keyring or KWallet) for encrypted storage." })
})

app.on("activate", () => show())
app.on("before-quit", () => {
  quitting = true
})
app.on("will-quit", e => {
  if (server) {
    e.preventDefault()
    const s = server
    server = null
    void s.close().finally(() => app.exit(0))
  }
})
app.on("window-all-closed", () => {
  if (!tray && process.platform !== "darwin") app.quit()
})
