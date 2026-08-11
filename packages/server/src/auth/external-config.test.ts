import { afterEach, describe, expect, it } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { ExternalAuthConfig, isKnowledgeMode } from "./external-config"

afterEach(() => {
  delete process.env.KNOWLEDGE_SESSION_ISOLATION
})

describe("ExternalAuthConfig", () => {
  it("defaults to /api when env var is not set", () => {
    const provider = ConfigProvider.fromEnv({ env: {} })
    const testLayer = ExternalAuthConfig.layer.pipe(
      Layer.provideMerge(ConfigProvider.layer(provider)),
    )

    const result = Effect.runSync(
      Effect.gen(function* () {
        const svc = yield* ExternalAuthConfig
        return svc.apiBaseUrl
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe("/api")
  })

  it("reads the KNOWLEDGE_API_BASE_URL env var when set", () => {
    const provider = ConfigProvider.fromEnv({
      env: { KNOWLEDGE_API_BASE_URL: "https://knowledge.example.com/api" },
    })
    const testLayer = ExternalAuthConfig.layer.pipe(
      Layer.provideMerge(ConfigProvider.layer(provider)),
    )

    const result = Effect.runSync(
      Effect.gen(function* () {
        const svc = yield* ExternalAuthConfig
        return svc.apiBaseUrl
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe("https://knowledge.example.com/api")
  })

  it("accepts an empty string env var", () => {
    const provider = ConfigProvider.fromEnv({
      env: { KNOWLEDGE_API_BASE_URL: "" },
    })
    const testLayer = ExternalAuthConfig.layer.pipe(
      Layer.provideMerge(ConfigProvider.layer(provider)),
    )

    const result = Effect.runSync(
      Effect.gen(function* () {
        const svc = yield* ExternalAuthConfig
        return svc.apiBaseUrl
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe("")
  })

  it("can be provided with a custom layer", () => {
    const customLayer = Layer.succeed(
      ExternalAuthConfig,
      ExternalAuthConfig.of({ apiBaseUrl: "https://custom/api" }),
    )

    const result = Effect.runSync(
      Effect.gen(function* () {
        const svc = yield* ExternalAuthConfig
        return svc.apiBaseUrl
      }).pipe(Effect.provide(customLayer)),
    )
    expect(result).toBe("https://custom/api")
  })
})

describe("isKnowledgeMode", () => {
  it("is false when KNOWLEDGE_SESSION_ISOLATION is not set", () => {
    delete process.env.KNOWLEDGE_SESSION_ISOLATION
    expect(isKnowledgeMode()).toBe(false)
  })

  it("is true when KNOWLEDGE_SESSION_ISOLATION=true", () => {
    process.env.KNOWLEDGE_SESSION_ISOLATION = "true"
    expect(isKnowledgeMode()).toBe(true)
  })

  it("is false for other values", () => {
    process.env.KNOWLEDGE_SESSION_ISOLATION = "1"
    expect(isKnowledgeMode()).toBe(false)
  })
})
