/**
 * codex-doubao-shim — spawns the local OpenAI-compatible embedding proxy
 * that fronts doubao-embedding-vision, so opencode-mem (or any
 * OpenAI-compatible embedding client) can call it as if it were an
 * OpenAI endpoint.
 *
 * - Starts on first plugin init; port 4748 (override via env PORT).
 * - Idempotent: if the port is already responding to /health, skip spawn.
 * - Killed on dispose() via SIGTERM.
 * - Requires ARK_KEY env var (see README).
 */

import type { Plugin } from "@opencode-ai/plugin"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PORT = Number(process.env.OPENCODE_SHIM_PORT ?? 4748)
// Resolve server.ts alongside this plugin file (both live in the npm package root).
const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = join(HERE, "server.ts")

let proc: ChildProcess | null = null

async function isAlive(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) })
    return res.ok
  } catch { return false }
}

export const CodexDoubaoShimPlugin: Plugin = async () => {
  if (!existsSync(SERVER_PATH)) {
    console.error(`[codex-doubao-shim] server not found at ${SERVER_PATH}`)
    return {}
  }

  if (await isAlive()) {
    console.log(`[codex-doubao-shim] already running at :${PORT}`)
  } else {
    if (!process.env.ARK_KEY) {
      console.error("[codex-doubao-shim] ARK_KEY env var not set — shim will not start. See README.")
      return {}
    }
    proc = spawn("bun", ["run", SERVER_PATH], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PORT: String(PORT) },
    })
    proc.unref()
    console.log(`[codex-doubao-shim] spawned pid=${proc.pid} at :${PORT}`)

    // Poll until shim is ready — opencode-mem warms up embeddings right after
    // plugin init and fails permanently on the first connection error.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await isAlive()) {
        console.log(`[codex-doubao-shim] health OK at :${PORT}`)
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!(await isAlive())) {
      console.error(`[codex-doubao-shim] WARN: shim not ready after 5s`)
    }
  }

  return {
    dispose: async () => {
      if (proc && proc.pid) {
        try { process.kill(proc.pid, "SIGTERM") } catch {}
      }
    },
  }
}

export default CodexDoubaoShimPlugin
