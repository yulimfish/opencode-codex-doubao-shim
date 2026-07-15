/**
 * doubao-embedding-shim — translates OpenAI-compatible /embeddings requests
 * into Ark's /api/plan/v3/embeddings/multimodal, and reshapes the response
 * back into OpenAI shape so opencode-mem (or any OpenAI-compatible embedding
 * client) can use doubao-embedding-vision transparently.
 *
 * Ark quirk: /api/plan/v3/embeddings/multimodal returns `data` as a bare
 * object `{embedding: [...]}` — not the OpenAI-standard `data: [{embedding: [...], index: 0}]`.
 * This shim normalises that.
 *
 * Env (required):
 *   ARK_KEY   — Ark API key (get from https://console.volcengine.com/ark)
 * Env (optional):
 *   ARK_URL   — override endpoint
 *   ARK_MODEL — default: doubao-embedding-vision-250615
 *   PORT      — default: 4748
 */

const ARK_URL = process.env.ARK_URL ?? "https://ark.cn-beijing.volces.com/api/plan/v3/embeddings/multimodal"
const ARK_KEY = process.env.ARK_KEY
const DEFAULT_MODEL = process.env.ARK_MODEL ?? "doubao-embedding-vision-250615"
const PORT = Number(process.env.PORT ?? 4748)

if (!ARK_KEY) {
  console.error("[doubao-shim] FATAL: ARK_KEY env var is required. See README.")
  process.exit(1)
}

async function embedOne(text: string, model: string): Promise<number[]> {
  const clipped = text.length > 6000 ? text.slice(0, 6000) : text
  const res = await fetch(ARK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ARK_KEY}` },
    body: JSON.stringify({
      model,
      encoding_format: "float",
      input: [{ type: "text", text: clipped }],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`ark http ${res.status}: ${body.slice(0, 200)}`)
  }
  const j = (await res.json()) as any
  const d = j?.data
  if (Array.isArray(d)) {
    const e = d[0]?.embedding
    if (Array.isArray(e?.[0])) return e[0]
    if (Array.isArray(e)) return e
  } else if (d && typeof d === "object") {
    const e = d.embedding
    if (Array.isArray(e?.[0])) return e[0]
    if (Array.isArray(e)) return e
  }
  throw new Error("ark: unexpected response shape")
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/health") return Response.json({ ok: true, model: DEFAULT_MODEL })
    if (url.pathname !== "/embeddings" && url.pathname !== "/v1/embeddings") {
      return new Response("Not Found", { status: 404 })
    }
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 })
    try {
      const body = (await req.json()) as any
      const model = body?.model || DEFAULT_MODEL
      const inputRaw = body?.input
      const inputs: string[] = Array.isArray(inputRaw) ? inputRaw : [inputRaw]
      const strings = inputs.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      const vectors = await Promise.all(strings.map((s) => embedOne(s, model)))
      return Response.json({
        object: "list",
        model,
        data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      })
    } catch (e: any) {
      return Response.json(
        { error: { message: String(e?.message ?? e), type: "shim_error" } },
        { status: 500 },
      )
    }
  },
})

console.log(`[doubao-shim] OpenAI-compatible embedding proxy on http://127.0.0.1:${PORT}/v1/embeddings (model=${DEFAULT_MODEL})`)
