import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ExternalIdentityAdapterTag } from "@opencode-ai/server/auth/external-identity"
import { ExternalAuthConfig } from "@opencode-ai/server/auth/external-config"
import { KnowledgeAdapterLayer } from "./knowledge-adapter"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "abcdefghijklmnopqrstuvwxyz"

beforeEach(() => {
  process.env.KNOWLEDGE_JWT_SECRET = SECRET
})
afterEach(() => {
  delete process.env.KNOWLEDGE_JWT_SECRET
  delete process.env.KNOWLEDGE_JWT_PUBLIC_KEY
  delete process.env.KNOWLEDGE_JWT_JWKS_URL
})

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url")
}

function signHs256(payload: Record<string, unknown>, secret = SECRET): string {
  const signingInput = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}`
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url")
  return `${signingInput}.${sig}`
}

function createMockHttpClient(getKnowledgeResponse: unknown) {
  return HttpClient.make((request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/system/user/getKnowledge")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(getKnowledgeResponse)),
      )
    }
    return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
  })
}

function makeConfig() {
  return ExternalAuthConfig.of({ apiBaseUrl: "http://localhost/api" })
}

function runAuthenticate(token: string, clientId?: string, config = makeConfig()) {
  return (httpClient: HttpClient.HttpClient) =>
    Effect.gen(function* () {
      const adapter = yield* ExternalIdentityAdapterTag
      return yield* adapter.authenticate(token, clientId)
    }).pipe(
      Effect.provide(KnowledgeAdapterLayer),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(ExternalAuthConfig, config),
    )
}

function okKnowledgeResponse() {
  return {
    code: 200,
    data: {
      workspaces: [
        {
          workspaceId: "kb_001",
          workspaceName: "Product Knowledge Base",
          categories: [{ categoryId: "cat_1", categoryName: "Documents", parentId: undefined, sort: 1 }],
        },
      ],
      permissions: { kb_001: ["read", "write", "admin"] },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KnowledgeAdapter (JWT signature verification)", () => {
  it("resolves identity from a correctly signed HS256 JWT", async () => {
    const httpClient = createMockHttpClient(okKnowledgeResponse())
    const token = signHs256({ userId: 1001, userName: "Alice", tenantId: "tenant_01" })

    const result = await Effect.runPromise(runAuthenticate(token)(httpClient))

    expect(result.userId).toBe("1001")
    expect(result.nickName).toBe("Alice")
    expect(result.tenantId).toBe("tenant_01")
    expect(result.workspaces).toHaveLength(1)
    expect(result.workspaces[0].workspaceId).toBe("kb_001")
    expect(result.permissions["kb_001"]).toEqual(["read", "write", "admin"])
  })

  it("rejects a tampered payload — returns empty identity (fail-closed)", async () => {
    const httpClient = createMockHttpClient(okKnowledgeResponse())
    const good = signHs256({ userId: 1001, userName: "Alice", tenantId: "tenant_01" })
    const [headerB64, , sig] = good.split(".")
    // Forge the payload: claim to be a different user without re-signing.
    const forged = `${headerB64}.${b64url({ userId: 9999, userName: "Admin", tenantId: "tenant_02" })}.${sig}`

    const result = await Effect.runPromise(runAuthenticate(forged)(httpClient))

    expect(result.userId).toBe("")
  })

  it("rejects a token signed with the wrong secret — empty identity", async () => {
    const httpClient = createMockHttpClient(okKnowledgeResponse())
    const token = signHs256({ userId: 1001, userName: "Alice" }, "wrong-secret")

    const result = await Effect.runPromise(runAuthenticate(token)(httpClient))

    expect(result.userId).toBe("")
  })

  it("rejects an expired token — empty identity", async () => {
    const httpClient = createMockHttpClient(okKnowledgeResponse())
    const token = signHs256({ userId: 1001, userName: "Alice", exp: Math.floor(Date.now() / 1000) - 60 })

    const result = await Effect.runPromise(runAuthenticate(token)(httpClient))

    expect(result.userId).toBe("")
  })

  it("fails closed when no verification key is configured", async () => {
    delete process.env.KNOWLEDGE_JWT_SECRET
    const httpClient = createMockHttpClient(okKnowledgeResponse())
    const token = signHs256({ userId: 1001, userName: "Alice" })

    const result = await Effect.runPromise(runAuthenticate(token)(httpClient))

    expect(result.userId).toBe("")
  })

  it("defaults tenantId to 000000 when not provided", async () => {
    const httpClient = createMockHttpClient({ code: 200, data: { workspaces: [], permissions: {} } })
    const token = signHs256({ userId: 2, userName: "User" })

    const result = await Effect.runPromise(runAuthenticate(token)(httpClient))

    expect(result.userId).toBe("2")
    expect(result.tenantId).toBe("000000")
  })

  it("returns empty workspaces and permissions when getKnowledge fails, but identity stays", async () => {
    const httpClient = createMockHttpClient({ code: 500, msg: "Server error" })
    const token = signHs256({ userId: 6, userName: "Partial", tenantId: "t" })

    const result = await Effect.runPromise(runAuthenticate(token)(httpClient))

    expect(result.userId).toBe("6")
    expect(result.workspaces).toEqual([])
    expect(result.permissions).toEqual({})
  })

  it("sends clientid header when clientId is provided", async () => {
    let capturedClientId: string | undefined
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/system/user/getKnowledge")) {
        capturedClientId = request.headers["clientid"]
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(okKnowledgeResponse())))
      }
      return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
    })
    const token = signHs256({ userId: 3, userName: "Client" })

    await Effect.runPromise(runAuthenticate(token, "my-client-id")(httpClient))

    expect(capturedClientId).toBe("my-client-id")
  })

  it("sends the Bearer JWT and Accept header to the business API", async () => {
    let capturedAuth: string | undefined
    let capturedAccept: string | undefined
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/system/user/getKnowledge")) {
        capturedAuth = request.headers["authorization"]
        capturedAccept = request.headers["accept"]
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(okKnowledgeResponse())))
      }
      return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
    })
    const token = signHs256({ userId: 8, userName: "Bearer" })

    await Effect.runPromise(runAuthenticate(token)(httpClient))

    expect(capturedAuth).toBe(`Bearer ${token}`)
    expect(capturedAccept).toBe("application/json")
  })

  it("caches identity so the same token does not call the API again", async () => {
    let getKnowledgeCallCount = 0
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/system/user/getKnowledge")) {
        getKnowledgeCallCount++
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(okKnowledgeResponse())))
      }
      return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
    })
    const token = signHs256({ userId: 5, userName: "Cached" })

    const result1 = await Effect.runPromise(runAuthenticate(token)(httpClient))
    const result2 = await Effect.runPromise(runAuthenticate(token)(httpClient))

    expect(result1.userId).toBe("5")
    expect(result2.userId).toBe("5")
    expect(getKnowledgeCallCount).toBe(1)
  })
})
