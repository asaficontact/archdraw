// The user's LLM: which providers archdraw speaks to (with the user's own key), and the default models for chat and
// for the cheap "did the architecture change?" triage. Keys never touch disk here: a KeyStore hands them over per
// request (the internal build reads ~/work/secrets/providers.env; the desktop app, the OS keychain).

import { readFileSync, statSync } from "node:fs"
import { createModels, type Model, type Models } from "@earendil-works/pi-ai"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { googleProvider } from "@earendil-works/pi-ai/providers/google"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"

export const PROVIDERS = {
  openai: { name: "OpenAI", env: "OPENAI_API_KEY", chat: "gpt-5.6-terra", triage: "gpt-5.4-mini", prefix: "sk-", keyUrl: "https://platform.openai.com/api-keys" },
  anthropic: { name: "Anthropic", env: "ANTHROPIC_API_KEY", chat: "claude-sonnet-5-5", triage: "claude-haiku-4-5", prefix: "sk-ant-", keyUrl: "https://console.anthropic.com/settings/keys" },
  google: { name: "Google", env: "GEMINI_API_KEY", chat: "gemini-3.5-flash", triage: "gemini-3.5-flash-lite", prefix: "AIza", keyUrl: "https://aistudio.google.com/apikey" },
  openrouter: { name: "OpenRouter", env: "OPENROUTER_API_KEY", chat: "anthropic/claude-sonnet-5-5", triage: "openai/gpt-5.4-mini", prefix: "sk-or-", keyUrl: "https://openrouter.ai/keys" },
} as const

export type ProviderId = keyof typeof PROVIDERS

/** Which provider a pasted key belongs to, from its prefix (most specific first). */
export function providerOfKey(key: string): ProviderId | null {
  const k = key.trim()
  if (k.startsWith("sk-ant-")) return "anthropic"
  if (k.startsWith("sk-or-")) return "openrouter"
  if (k.startsWith("AIza")) return "google"
  if (k.startsWith("sk-")) return "openai"
  return null
}

export interface KeyStore {
  get(provider: string): string | undefined
  set?(provider: string, key: string): void
  has(provider: string): boolean
}

/**
 * Keys from the environment, else from an owner-only KEY=value file (the internal box's providers.env). The file is
 * refused when anyone but its owner can read it; keys are never logged or returned to the browser.
 */
export class EnvKeys implements KeyStore {
  constructor(private file?: string) {}
  get(provider: string): string | undefined {
    const name = PROVIDERS[provider as ProviderId]?.env
    if (!name) return undefined
    if (process.env[name]) return process.env[name]
    if (!this.file) return undefined
    try {
      const st = statSync(this.file)
      if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) return undefined
      for (const raw of readFileSync(this.file, "utf8").split("\n")) {
        const line = raw.trim().replace(/^export\s+/, "")
        const i = line.indexOf("=")
        if (i > 0 && line.slice(0, i) === name) return line.slice(i + 1).trim().replace(/^["']|["']$/g, "") || undefined
      }
    } catch {
      /* no file */
    }
    return undefined
  }
  has(provider: string) {
    return !!this.get(provider)
  }
}

/** Keys held in memory (tests, and the desktop app after it unlocks the keychain). */
export class MemoryKeys implements KeyStore {
  private keys = new Map<string, string>()
  get(p: string) {
    return this.keys.get(p)
  }
  set(p: string, k: string) {
    this.keys.set(p, k)
  }
  has(p: string) {
    return this.keys.has(p)
  }
}

export type ModelSet = ReturnType<typeof createModels>

let shared: ModelSet | null = null

/** One model collection with the four providers registered (the SDKs load lazily on first use). */
export function models(): ModelSet {
  if (!shared) {
    shared = createModels()
    for (const p of [openaiProvider(), anthropicProvider(), googleProvider(), openrouterProvider()]) shared.setProvider(p)
  }
  return shared
}

/** The chat or triage model for these settings, falling back to the provider's default. */
export function pickModel(m: Models, provider: string, id: string, role: "chat" | "triage"): Model<any> {
  const p = PROVIDERS[provider as ProviderId]
  const want = id || (p ? p[role] : "")
  const model = m.getModel(provider as any, want) ?? (p ? m.getModel(provider as any, p[role]) : undefined)
  if (!model) throw new Error(`no model ${want || "(none)"} for ${provider}; pick one in Settings`)
  return model
}
