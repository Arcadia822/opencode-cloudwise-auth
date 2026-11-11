// Cloudwise MaaS (api.cloudwise.ai) for OpenCode and magpie.
//
// Cloudwise serves an OpenAI-compatible inference API under /api/v1: an
// account's API key signs every request (Authorization: Bearer), GET
// /api/v1/models lists the platform's catalogue, POST
// /api/v1/chat/completions serves it, and GET
// /api/v1/usage/account-credit-summary reports the account's credit
// allowance: its currency, account type, balance type, the total granted,
// the amount used so far, the amount left and when all of that was read.
//
// The catalogue is the platform's, not the key's: a key with a narrower
// allow-list answers 403 {"error":"Model … is not allowed for this API key"}
// for a model it doesn't carry, and `auto` (Cloudwise's smart routing) is
// served to every key. The usage hook is the account's own reading, so it
// costs no request of a model.

const ID = "cloudwise"
const NPM = "@ai-sdk/openai-compatible"
const BASE = "https://api.cloudwise.ai/api/v1"
const MODELS = `${BASE}/models`
const SUMMARY = `${BASE}/usage/account-credit-summary`

// Cloudwise marks a successful business reply 10000 in an HTTP 200. Its
// failures come in more than one envelope, so read whichever it sent.
const OK = 10000

// Models that reason on their own: Cloudwise names the effort-taking ones
// "thinking", and serves the OpenAI o-series and GPT-5 line as reasoning
// models too. Everything else answers plainly.
const REASONING = /(^|[-_/])(thinking|reasoner|r1|o[1-9])([-_.]|$)|gpt-5/i

const num = (v, fallback = 0) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : fallback
}

const text = (v) => (typeof v === "string" ? v.trim() : "")

// amount is one of Cloudwise's decimal amounts, grouped and cut to the two
// places a currency has.
const amount = (v) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number.isFinite(v) ? v : 0,
  )

// clock is a reading's time as the summary states it ("2026-11-11T16:36:09+08:00"
// → "16:36+08:00"), so a card says how fresh the figure is.
function clock(iso) {
  const m = /T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?/.exec(text(iso))
  return m ? `${m[1]}${m[2] && m[2] !== "Z" ? m[2] : ""}` : ""
}

// isChat keeps the models an OpenAI-compatible chat endpoint serves: text
// (and image) in, text out. Image, video, audio and embedding models have
// their own endpoints and stay out of the picker.
function isChat(m) {
  if (typeof m?.id !== "string" || !m.id) return false
  const ai = m.architecture ?? {}
  const inputs = Array.isArray(ai.input_modalities) ? ai.input_modalities : []
  const outputs = Array.isArray(ai.output_modalities) ? ai.output_modalities : []
  if (outputs.length && !outputs.includes("text")) return false
  if (inputs.length && !inputs.includes("text")) return false
  const modality = text(ai.modality)
  if (modality && !modality.startsWith("text")) return false
  return true
}

// row is one model as both readers take it: the config hook reads the
// top-level fields, the models hook reads `capabilities`.
function row(m) {
  const ai = m?.architecture ?? {}
  const inputs = Array.isArray(ai.input_modalities) && ai.input_modalities.length ? ai.input_modalities : ["text"]
  const outputs = Array.isArray(ai.output_modalities) && ai.output_modalities.length ? ai.output_modalities : ["text"]
  const vision = inputs.includes("image") || inputs.includes("audio")
  const reasoning = REASONING.test(m.id)
  // Cloudwise prices a token, OpenCode prices a million of them.
  const perMillion = (v) => {
    const n = num(v, NaN)
    return Number.isFinite(n) ? n * 1e6 : undefined
  }
  const input = perMillion(m?.pricing?.prompt)
  const output = perMillion(m?.pricing?.completion)
  const cache = perMillion(m?.pricing?.input_cache_read)
  const cost = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cache !== undefined ? { cache_read: cache } : {}),
  }
  return {
    id: m.id,
    name: text(m.name) || m.id,
    limit: {
      context: num(m?.context_length, num(m?.top_provider?.context_length)),
      output: num(m?.top_provider?.max_completion_tokens),
    },
    reasoning,
    tool_call: true,
    attachment: vision,
    modalities: { input: inputs, output: outputs },
    capabilities: {
      reasoning,
      toolcall: true,
      attachment: vision,
      input: Object.fromEntries(inputs.map((kind) => [kind, true])),
      output: Object.fromEntries(outputs.map((kind) => [kind, true])),
    },
    ...(Object.keys(cost).length ? { cost } : {}),
  }
}

// catalogOf reads GET /models' reply as chat models by id.
function catalogOf(body) {
  const list = Array.isArray(body?.data) ? body.data : []
  const rows = {}
  for (const m of list) if (isChat(m)) rows[m.id] = row(m)
  return rows
}

// failureOf is whatever a failed reply says it went wrong, in either of
// Cloudwise's envelopes, and the HTTP status when it says nothing.
function failureOf(body, status) {
  const message =
    text(body?.message) ||
    text(body?.error) ||
    text(body?.error?.message) ||
    text(body?.ResponseMetadata?.Error?.Message)
  return message ? `Cloudwise: ${message}` : `Cloudwise answered HTTP ${status}`
}

// creditOf is the account's credit summary as usage: one window carrying
// the share used (the meter) and the amounts themselves, and the balance
// left in the account's own currency. total, used and available reconcile
// exactly, so the share is read from what Cloudwise sent, not recomputed
// from the balance.
function creditOf(data) {
  const currency = (text(data?.currency) || "USD").toUpperCase()
  const total = Math.max(0, num(data?.total_amount))
  const used = Math.max(0, num(data?.used_amount))
  const available = num(data?.available_amount)
  const share = total > 0 ? (100 * used) / total : 0
  const plan = [text(data?.account_type), text(data?.balance_type)].filter(Boolean).join(" · ")
  const at = clock(data?.query_time)
  return {
    ...(plan ? { plan } : {}),
    balance: `${amount(available)} ${currency}`,
    windows: [
      {
        name: "Credit",
        // past 100 when the account overspends, as magpie shows it
        used: Math.max(0, share),
        amount: used,
        limit: total,
        unit: currency,
        display: `${amount(used)} / ${amount(total)} ${currency}${at ? ` · ${at}` : ""}`,
      },
    ],
  }
}

function createPlugin({ fetchImpl = globalThis.fetch } = {}) {
  const call = (url, key) =>
    fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      // `??=` keeps a provider the user configured in plugins.json.
      cfg.provider[ID] ??= {
        name: "Cloudwise MaaS",
        npm: NPM,
        api: BASE,
        // `auto` is Cloudwise's smart routing and is served to every key,
        // so it is the one model a fresh install can offer before the
        // catalogue is read.
        models: { auto: row({ id: "auto", name: "Auto (Smart Routing)" }) },
      }
    },

    auth: {
      provider: ID,
      methods: [{ type: "api", label: "Cloudwise MaaS API key", placeholder: "ak_…" }],
      // magpie sends `Authorization: Bearer <apiKey>` for
      // @ai-sdk/openai-compatible; the host applies the account's proxy.
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return { baseURL: BASE, apiKey: auth.key }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { windows: [] }
        let res
        try {
          res = await call(SUMMARY, auth.key)
        } catch (error) {
          return {
            error: `Cloudwise unreachable: ${error?.cause?.code || error?.message || "network error"}`,
            windows: [],
          }
        }
        if (res.status === 401 || res.status === 403) {
          return { error: `Cloudwise refused this key (HTTP ${res.status}); sign in again`, signIn: "expired", windows: [] }
        }
        let body
        try {
          body = await res.json()
        } catch {
          return { error: `Cloudwise answered HTTP ${res.status} without JSON`, windows: [] }
        }
        if (!res.ok) return { error: failureOf(body, res.status), windows: [] }
        if (body?.code !== OK) return { error: failureOf(body, res.status), windows: [] }
        if (!body.data || typeof body.data !== "object") {
          return { error: "Cloudwise sent no credit summary", windows: [] }
        }
        return creditOf(body.data)
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        let res
        try {
          res = await call(MODELS, auth.key)
        } catch {
          // A network failure keeps the previous list, like a non-2xx answer.
          return provider.models
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`Cloudwise refused this key (HTTP ${res.status}); sign in again`), {
            signIn: "expired",
          })
        }
        if (!res.ok) return provider.models
        let body
        try {
          body = await res.json()
        } catch {
          throw new Error("Cloudwise sent no model list")
        }
        if (!Array.isArray(body?.data)) throw new Error("Cloudwise sent no model list")
        // An empty catalogue is the platform's own answer; keep what the
        // config declared so the picker never ends up with nothing.
        const rows = catalogOf(body)
        return Object.keys(rows).length ? rows : provider.models
      },
    },
}
}

// The plugin is the only exported function; magpie calls every exported
// function as a plugin, so tests reach the internals through this object.
export const CloudwisePlugin = async () => createPlugin()
export const _internal = { ID, NPM, BASE, MODELS, SUMMARY, OK, createPlugin, row, isChat, catalogOf, creditOf, failureOf, amount, clock }
