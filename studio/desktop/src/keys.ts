// The user's AI keys on the desktop: encrypted with the OS keychain through Electron's safeStorage (Keychain on macOS,
// Secret Service / KWallet on Linux, DPAPI on Windows), in a 0600 file in userData. On a Linux desktop with no keyring,
// safeStorage falls back to a hard-coded password ("basic_text"); `weak` says so, and the app tells the user.
// Keys set in the environment (OPENAI_API_KEY, ...) are used when none is stored.

import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { safeStorage } from "electron"
import { EnvKeys, type KeyStore } from "../../core/src/models.js"

export class SafeKeys implements KeyStore {
  private env = new EnvKeys()
  readonly weak: boolean

  constructor(private file: string) {
    const backend = process.platform === "linux" ? (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.() : "os"
    this.weak = !safeStorage.isEncryptionAvailable() || backend === "basic_text"
  }

  private all(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"))
    } catch {
      return {}
    }
  }

  get(provider: string): string | undefined {
    const sealed = this.all()[provider]
    if (sealed) {
      try {
        if (sealed.startsWith("plain:")) return Buffer.from(sealed.slice(6), "base64").toString("utf8")
        return safeStorage.decryptString(Buffer.from(sealed, "base64"))
      } catch {
        return undefined
      }
    }
    return this.env.get(provider)
  }

  set(provider: string, key: string): void {
    const all = this.all()
    // no keyring: the key is kept in this owner-only file with basic protection, and the app says so (`weak`)
    all[provider] = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key).toString("base64") : "plain:" + Buffer.from(key, "utf8").toString("base64")
    const tmp = this.file + ".tmp"
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  has(provider: string): boolean {
    return !!this.all()[provider] || this.env.has(provider)
  }
}
