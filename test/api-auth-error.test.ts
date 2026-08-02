import { describe, expect, it } from "vitest"

import { isTokenExpiredResponse } from "../lib/api-auth-error"

describe("OpenAI token-expired response detection", () => {
  it("detects exact OpenAI token-expired codes without consuming the response", async () => {
    const response = new Response(JSON.stringify({ error: { code: "token_expired" } }), {
      status: 401,
      headers: { "content-type": "application/json" }
    })

    await expect(isTokenExpiredResponse(response)).resolves.toBe(true)
    expect(response.bodyUsed).toBe(false)
    await expect(response.json()).resolves.toEqual({ error: { code: "token_expired" } })
  })

  it("detects the exact OpenAI error header without reading an oversized body", async () => {
    const response = new Response("x".repeat(70_000), {
      status: 401,
      headers: { "x-openai-ide-error-code": "token_expired" }
    })

    await expect(isTokenExpiredResponse(response)).resolves.toBe(true)
    expect(response.bodyUsed).toBe(false)
  })

  it.each([
    new Response(JSON.stringify({ error: { code: "invalid_token", message: "token expired" } }), { status: 401 }),
    new Response(JSON.stringify({ error: { message: "Provided authentication token is expired." } }), { status: 401 }),
    new Response("not json", { status: 401 }),
    new Response(JSON.stringify({ error: { code: "token_expired" } }), { status: 403 })
  ])("leaves unrelated responses unchanged", async (response) => {
    await expect(isTokenExpiredResponse(response)).resolves.toBe(false)
    expect(response.bodyUsed).toBe(false)
  })

  it("bounds nested error traversal", async () => {
    const response = Response.json(
      { error: { error: { error: { error: { error: { code: "token_expired" } } } } } },
      { status: 401 }
    )
    await expect(isTokenExpiredResponse(response)).resolves.toBe(false)
  })

  it("times out a stalled 401 body and leaves the original response untouched", async () => {
    const response = new Response(new ReadableStream({ start() {} }), { status: 401 })
    const started = Date.now()
    await expect(isTokenExpiredResponse(response)).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(response.bodyUsed).toBe(false)
    await response.body?.cancel()
  })
})
