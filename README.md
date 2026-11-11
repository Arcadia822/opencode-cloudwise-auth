# @magpie-community/opencode-cloudwise-auth

Signs in to **Cloudwise MaaS** (`api.cloudwise.ai`) with an account's API key
and calls the models it serves: Cloudwise exposes an OpenAI-compatible
inference API under `/api/v1`, and every request is signed with
`Authorization: Bearer <key>`. Provider id: `cloudwise`.

Beside a `cloudwise` provider you added by hand, magpie names this plugin's
provider `cloudwise-plugin`, so the two keep their own rows and keys; a
fresh install with no such provider gets `cloudwise` itself.

## Sign-in

Add a Cloudwise MaaS API key in magpie or OpenCode. The key is kept as an
`api` sign-in and sent as the bearer token of every request. A key Cloudwise
refuses marks the account signed out, so magpie asks for it again.

## Models

`GET /api/v1/models` lists the platform's catalogue, and the plugin offers
the models an OpenAI-compatible chat endpoint serves: text (and image) in,
text out. Image, video, audio and embedding models have endpoints of their
own and stay out of the picker.

- The catalogue is the **platform's**, not the key's. A key with a narrower
  allow-list answers `403 {"error":"Model … is not allowed for this API key"}`
  for a model it doesn't carry.
- `auto` is Cloudwise's smart routing and is served to every key, so it is
  the one model offered before the catalogue is read.
- A model's price is per token at Cloudwise and per million tokens here, so
  the plugin multiplies by 1,000,000.
- The list is read again on every refresh; a network failure keeps the
  previous one.

## Usage

`GET /api/v1/usage/account-credit-summary` reports the account's credit
allowance:

```json
{"code":10000,"message":"success","data":{
  "currency":"USD","account_type":"Regular","balance_type":"QUOTA",
  "total_amount":2000000.00000000,
  "used_amount":52788.98948252,
  "available_amount":1947211.01051748,
  "query_time":"2026-11-11T16:36:09+08:00"}}
```

The plugin shows it as one **Credit** window and a balance:

- the meter is the **share used** (`100 × used_amount / total_amount`),
  past 100 when the account overspends;
- the line under it is the **absolute amount**, `used / total` in the
  account's currency (`52,788.99 / 2,000,000.00 USD`), with the reading's
  time (`· 16:36+08:00`) so a stale figure is recognisable;
- the **balance** is `available_amount` (`1,947,211.01 USD`), the figure
  Cloudwise itself computed rather than `total − used`;
- the plan line is the account's `account_type` and `balance_type`
  (`Regular · QUOTA`).

`total_amount = used_amount + available_amount` reconciles exactly, and the
window uses Cloudwise's own share rather than recomputing one from the
balance. An account with no allowance reads 0%, not a division by zero.

A refused key says so and marks the account signed out; a business failure
is shown with Cloudwise's message, from whichever envelope it came in
(`{code,message,data}`, `{error}`, or `{ResponseMetadata:{Error}}`).

## Notes

- The summary is account-wide and has no per-key or per-day split; Cloudwise
  publishes none.
- `balance_type: "QUOTA"` is a granted allowance, not necessarily cash.
- The summary is read at most once per refresh; it costs no model request.
