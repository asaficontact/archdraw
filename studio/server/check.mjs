// The studio's engine check: the source on stdin, the engine's error on stderr and exit 1, or exit 0 when it
// renders. It calls compile() with no icon-file reader, so a file icon in any spelling is refused by the engine
// itself instead of being read from disk (review of archdraw#1, L-b); the CLI reads icon files, this never does.
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const engine = process.argv[2]
const { compile } = await import(pathToFileURL(engine).href)
const source = readFileSync(0, "utf8")
try {
  compile(source)
} catch (e) {
  const line = e && typeof e.line === "number" && e.line > 0 ? `line ${e.line}: ` : ""
  process.stderr.write(line + String(e instanceof Error ? e.message : e) + "\n")
  process.exit(1)
}
