import { describe, expect, test } from "bun:test"
import { CloudwisePlugin, _internal } from "./index.mjs"

const { createPlugin, row, isChat, catalogOf, creditOf, failureOf, clock, BASE, MODELS, SUMMARY } = _internal

function jsonRes(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function fakeFetch(handler) {
  return async (input, init) => handler(String(input), init)
}

const auth = { type: "api", key: "cw_test" }

// The real reply, cut to the fields the plugin reads.
const SUMMARY_OK = {
  code: 10000,
  message: "success",
  data: {
    currency: "USD",
    account_type: "Regular",
    balance_type: "QUOTA",
    total_amount: 2000000.0,
    used_amount: 52788.98948252,
    available_amount: 1947211.01051748,
    query_time: "2026-11-11T16:36:09+08:00",
  },
}

const MODEL = {
  id: "gpt-4o",
  name: "GPT-4o",
  context_length: 128000,
  architecture: {
    modality: "text->text",
    input_modalities: ["text"],
    output_modalities: ["text"],
  },
  pricing: { prompt: "0.0000025", completion: "0.00001", input_cache_read: "0.00000125" },
  top_provider: { context_length: 128000, max_completion_tokens: 16384 },
}

describe("config", () => {
  test("declares the Cloudwise provider with auto as the bootstrap model", async () => {
    const plugin = await createPlugin()
    const cfg = {}
    await plugin.config(cfg)
    const p = cfg.provider.cloudwise
    expect(p.name).toBe("Cloudwise MaaS")
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(p.api).toBe(BASE)
    expect(Object.keys(p.models)).toEqual(["auto"])
    expect(p.models.auto.name).toBe("Auto (Smart Routing)")
  })

  test("keeps a provider the user configured", async () => {
    const plugin = await createPlugin()
    const cfg = { provider: { cloudwise: { name: "Mine" } } }
    await plugin.config(cfg)
    expect(cfg.provider.cloudwise.name).toBe("Mine")
  })
})

describe("loader", () => {
  test("maps an api account to the base URL and key", async () => {
    const plugin = await createPlugin()
    expect(await plugin.auth.loader(async () => auth)).toEqual({ baseURL: BASE, apiKey: "cw_test" })
  })

  test("loads nothing without an api key", async () => {
    const plugin = await createPlugin()
    expect(await plugin.auth.loader(async () => undefined)).toEqual({})
    expect(await plugin.auth.loader(async () => ({ type: "oauth", key: "x" }))).toEqual({})
    expect(await plugin.auth.loader(async () => ({ type: "api" }))).toEqual({})
  })

  test("offers an api key sign-in", async () => {
    const plugin = await createPlugin()
    expect(plugin.auth.provider).toBe("cloudwise")
    expect(plugin.auth.methods).toEqual([{ type: "api", label: "Cloudwise MaaS API key", placeholder: "ak_…" }])
  })
})

describe("models", () => {
  test("keeps chat models and leaves image, video and embedding models out", () => {
    expect(isChat(MODEL)).toBe(true)
    expect(isChat({ ...MODEL, id: "seedream-4-5", architecture: { modality: "text+image->image", input_modalities: ["text", "image"], output_modalities: ["image"] } })).toBe(false)
    expect(isChat({ ...MODEL, id: "wan2.6-t2v", architecture: { modality: "text->video", input_modalities: ["text"], output_modalities: ["video"] } })).toBe(false)
    expect(isChat({ id: "" })).toBe(false)
  })

  test("maps a model's limits, price per million and vision input", () => {
    const r = row(MODEL)
    expect(r.id).toBe("gpt-4o")
    expect(r.limit).toEqual({ context: 128000, output: 16384 })
    expect(r.cost).toEqual({ input: 2.5, output: 10, cache_read: 1.25 })
    expect(r.modalities.input).toEqual(["text"])
    expect(r.attachment).toBe(false)
    const vision = row({ ...MODEL, id: "gemini-3-pro", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } })
    expect(vision.attachment).toBe(true)
    expect(vision.capabilities.input).toEqual({ text: true, image: true })
  })

  test("reads the catalogue as chat models by id", () => {
    const rows = catalogOf({ data: [MODEL, { id: "seedream-4-5", architecture: { modality: "text+image->image", output_modalities: ["image"] } }] })
    expect(Object.keys(rows)).toEqual(["gpt-4o"])
  })

  test("returns the key's catalogue and keeps the bootstrap list on a network failure", async () => {
    const ok = await createPlugin({ fetchImpl: fakeFetch(() => jsonRes(200, { data: [MODEL] })) })
    const provider = { models: { auto: row({ id: "auto" }) } }
    const models = await ok.provider.models(provider, { auth })
    expect(Object.keys(models)).toEqual(["gpt-4o"])

    const down = await createPlugin({ fetchImpl: fakeFetch(() => { throw new Error("offline") }) })
    expect(await down.provider.models(provider, { auth })).toBe(provider.models)
  })

  test("marks the account signed out when Cloudwise refuses the key", async () => {
    const plugin = await createPlugin({ fetchImpl: fakeFetch(() => jsonRes(403, { error: "Model x is not allowed for this API key" })) })
    await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toMatchObject({ signIn: "expired" })
  })

  test("asks the catalogue with the account's key", async () => {
    let seen
    const plugin = await createPlugin({ fetchImpl: fakeFetch((input, init) => { seen = { input, init }; return jsonRes(200, { data: [] }) }) })
    await plugin.provider.models({ models: { auto: row({ id: "auto" }) } }, { auth })
    expect(seen.input).toBe(MODELS)
    expect(seen.init.headers.authorization).toBe("Bearer cw_test")
  })
})

describe("usage", () => {
  test("shows the share used and the absolute amounts, with the balance left", async () => {
    const plugin = await createPlugin({ fetchImpl: fakeFetch(() => jsonRes(200, SUMMARY_OK)) })
    const u = await plugin.auth.usage(async () => auth)
    expect(u.plan).toBe("Regular · QUOTA")
    expect(u.balance).toBe("1,947,211.01 USD")
    expect(u.windows).toHaveLength(1)
    const w = u.windows[0]
    expect(w.name).toBe("Credit")
    expect(w.used).toBeCloseTo(2.639449, 5)
    expect(w.amount).toBeCloseTo(52788.98948252, 6)
    expect(w.limit).toBe(2000000)
    expect(w.unit).toBe("USD")
    expect(w.display).toBe("52,788.99 / 2,000,000.00 USD · 16:36+08:00")
  })

  test("reports a share of zero for an empty allowance instead of dividing by it", () => {
    const u = creditOf({ total_amount: 0, used_amount: 0, available_amount: 0, currency: "USD" })
    expect(u.windows[0].used).toBe(0)
    expect(u.windows[0].display).toBe("0.00 / 0.00 USD")
  })

  test("keeps a share past 100 when the account overspends", () => {
    const u = creditOf({ total_amount: 100, used_amount: 120, available_amount: -20, currency: "USD" })
    expect(u.windows[0].used).toBe(120)
    expect(u.balance).toBe("-20.00 USD")
  })

  test("marks the account signed out when Cloudwise refuses the key", async () => {
    const plugin = await createPlugin({ fetchImpl: fakeFetch(() => jsonRes(401, { code: 40101, message: "Authentication failed", data: null })) })
    const u = await plugin.auth.usage(async () => auth)
    expect(u.signIn).toBe("expired")
    expect(u.windows).toEqual([])
  })

  test("says what a business failure said, from either envelope", async () => {
    const plugin = await createPlugin({ fetchImpl: fakeFetch(() => jsonRes(200, { code: 10001, message: "Request method 'GET' not supported", data: null })) })
    const u = await plugin.auth.usage(async () => auth)
    expect(u.error).toBe("Cloudwise: Request method 'GET' not supported")

    expect(failureOf({ ResponseMetadata: { Error: { Message: "Invalid Authorization header" } } }, 401)).toBe("Cloudwise: Invalid Authorization header")
    expect(failureOf({ error: "Model x is not allowed for this API key" }, 403)).toBe("Cloudwise: Model x is not allowed for this API key")
    expect(failureOf({}, 500)).toBe("Cloudwise answered HTTP 500")
  })

  test("keeps the card empty, with the reason, when Cloudwise is unreachable", async () => {
    const plugin = await createPlugin({ fetchImpl: fakeFetch(() => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }) }) })
    const u = await plugin.auth.usage(async () => auth)
    expect(u.error).toBe("Cloudwise unreachable: ENOTFOUND")
    expect(u.windows).toEqual([])
  })

  test("asks the summary with the account's key", async () => {
    let seen
    const plugin = await createPlugin({ fetchImpl: fakeFetch((input, init) => { seen = { input, init }; return jsonRes(200, SUMMARY_OK) }) })
    await plugin.auth.usage(async () => auth)
    expect(seen.input).toBe(SUMMARY)
    expect(seen.init.headers.authorization).toBe("Bearer cw_test")
  })
})

describe("clock", () => {
  test("keeps the reading's time and offset", () => {
    expect(clock("2026-11-11T16:36:09+08:00")).toBe("16:36+08:00")
    expect(clock("2026-11-11T08:36:09Z")).toBe("08:36")
    expect(clock("")).toBe("")
  })
})

describe("plugin", () => {
  test("is the only export magpie's host calls", async () => {
    const hooks = await CloudwisePlugin()
    expect(hooks.auth.provider).toBe("cloudwise")
    expect(typeof hooks.auth.loader).toBe("function")
    expect(typeof hooks.auth.usage).toBe("function")
    expect(typeof hooks.provider.models).toBe("function")
  })
})
