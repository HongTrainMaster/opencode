import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ExternalIdentityAdapterTag } from "@opencode-ai/server/auth/external-identity"
import { ExternalAuthConfig } from "@opencode-ai/server/auth/external-config"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { KnowledgeAdapterLayer } from "./knowledge-adapter"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockHttpClient(
  getInfoResponse: unknown,
  getKnowledgeResponse: unknown,
) {
  return HttpClient.make((request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/system/user/getInfo")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(getInfoResponse)),
      )
    }
    if (url.pathname.endsWith("/system/user/getKnowledge")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(getKnowledgeResponse)),
      )
    }
    return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
  })
}

const testConfig = ExternalAuthConfig.of({ apiBaseUrl: "http://localhost/api" })

function runAuthenticate(token: string, clientId?: string) {
  return (httpClient: HttpClient.HttpClient) =>
    Effect.gen(function* () {
      const adapter = yield* ExternalIdentityAdapterTag
      return yield* adapter.authenticate(token, clientId)
    }).pipe(
      Effect.provide(KnowledgeAdapterLayer),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(ExternalAuthConfig, testConfig),
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KnowledgeAdapter", () => {
  it("returns ExternalIdentityInfo for valid token with all fields", async () => {
    const httpClient = createMockHttpClient(
      {
        code: 200,
        data: { user: { userId: 1, nickName: "Admin", tenantId: "tenant_01" } },
      },
      {
        code: 200,
        data: {
          workspaces: [
            {
              workspaceId: "kb_001",
              workspaceName: "Product Knowledge Base",
              categories: [
                {
                  categoryId: "cat_1",
                  categoryName: "Documents",
                  parentId: undefined,
                  sort: 1,
                },
              ],
            },
          ],
          permissions: { kb_001: ["read", "write", "admin"] },
        },
      },
    )

    const result = await Effect.runPromise(runAuthenticate("valid-token")(httpClient))

    expect(result.userId).toBe("1")
    expect(result.nickName).toBe("Admin")
    expect(result.tenantId).toBe("tenant_01")
    expect(result.workspaces).toHaveLength(1)
    expect(result.workspaces[0].workspaceId).toBe("kb_001")
    expect(result.workspaces[0].workspaceName).toBe("Product Knowledge Base")
    expect(result.workspaces[0].categories).toHaveLength(1)
    expect(result.workspaces[0].categories[0].categoryId).toBe("cat_1")
    expect(result.permissions["kb_001"]).toEqual(["read", "write", "admin"])
  })

  it("defaults tenantId to 000000 when not provided", async () => {
    const httpClient = createMockHttpClient(
      { code: 200, data: { user: { userId: 2, nickName: "User" } } },
      { code: 200, data: { workspaces: [], permissions: {} } },
    )

    const result = await Effect.runPromise(runAuthenticate("token-no-tenant")(httpClient))

    expect(result.userId).toBe("2")
    expect(result.tenantId).toBe("000000")
  })

  it("returns UnauthorizedError for invalid token (code !== 200)", async () => {
    const httpClient = createMockHttpClient(
      { code: 401, msg: "Invalid or expired token" },
      { code: 401 },
    )

    await expect(
      Effect.runPromise(runAuthenticate("bad-token")(httpClient)),
    ).rejects.toThrow(UnauthorizedError)
  })

  it("returns UnauthorizedError when getInfo response has no data", async () => {
    const httpClient = createMockHttpClient(
      { code: 200 },
      { code: 200, data: { workspaces: [], permissions: {} } },
    )

    await expect(
      Effect.runPromise(runAuthenticate("no-data-token")(httpClient)),
    ).rejects.toThrow(UnauthorizedError)
  })

  it("sends clientid header when clientId is provided", async () => {
    let capturedClientId: string | undefined
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/system/user/getInfo")) {
        capturedClientId = request.headers["clientid"]
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              code: 200,
              data: { user: { userId: 3, nickName: "Client" } },
            }),
          ),
        )
      }
      if (url.pathname.endsWith("/system/user/getKnowledge")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ code: 200, data: { workspaces: [], permissions: {} } }),
          ),
        )
      }
      return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
    })

    await Effect.runPromise(runAuthenticate("token-with-client", "my-client-id")(httpClient))

    expect(capturedClientId).toBe("my-client-id")
  })

  it("does not send clientid header when clientId is not provided", async () => {
    let capturedClientId: string | undefined
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/system/user/getInfo")) {
        capturedClientId = request.headers["clientid"]
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              code: 200,
              data: { user: { userId: 4, nickName: "NoClient" } },
            }),
          ),
        )
      }
      if (url.pathname.endsWith("/system/user/getKnowledge")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ code: 200, data: { workspaces: [], permissions: {} } }),
          ),
        )
      }
      return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
    })

    await Effect.runPromise(runAuthenticate("token-no-client")(httpClient))

    expect(capturedClientId).toBeUndefined()
  })

  it("caches identity so the same token does not call API again", async () => {
    let getInfoCallCount = 0
    let getKnowledgeCallCount = 0
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/system/user/getInfo")) {
        getInfoCallCount++
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              code: 200,
              data: { user: { userId: 5, nickName: "Cached" } },
            }),
          ),
        )
      }
      if (url.pathname.endsWith("/system/user/getKnowledge")) {
        getKnowledgeCallCount++
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ code: 200, data: { workspaces: [], permissions: {} } }),
          ),
        )
      }
      return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
    })

    // First call — should hit the API
    const result1 = await Effect.runPromise(runAuthenticate("cached-token")(httpClient))
    expect(result1.userId).toBe("5")
    expect(getInfoCallCount).toBe(1)
    expect(getKnowledgeCallCount).toBe(1)

    // Second call — should use cache
    const result2 = await Effect.runPromise(runAuthenticate("cached-token")(httpClient))
    expect(result2.userId).toBe("5")
    expect(getInfoCallCount).toBe(1)
    expect(getKnowledgeCallCount).toBe(1)
  })

  it("returns empty workspaces and permissions when getKnowledge fails", async () => {
    const httpClient = createMockHttpClient(
      {
        code: 200,
        data: { user: { userId: 6, nickName: "Partial" } },
      },
      { code: 500, msg: "Server error" },
    )

    const result = await Effect.runPromise(runAuthenticate("partial-token")(httpClient))

    expect(result.userId).toBe("6")
    expect(result.workspaces).toEqual([])
    expect(result.permissions).toEqual({})
  })

  it("returns empty workspaces and permissions when getKnowledge returns no data", async () => {
    const httpClient = createMockHttpClient(
      {
        code: 200,
        data: { user: { userId: 7, nickName: "NoKnowledge" } },
      },
      { code: 200 },
    )

    const result = await Effect.runPromise(runAuthenticate("no-knowledge-token")(httpClient))

    expect(result.userId).toBe("7")
    expect(result.workspaces).toEqual([])
    expect(result.permissions).toEqual({})
  })

  it("sends Bearer token in Authorization header", async () => {
    let capturedAuth: string | undefined
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/system/user/getInfo")) {
        capturedAuth = request.headers["authorization"]
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              code: 200,
              data: { user: { userId: 8, nickName: "Bearer" } },
            }),
          ),
        )
      }
      if (url.pathname.endsWith("/system/user/getKnowledge")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ code: 200, data: { workspaces: [], permissions: {} } }),
          ),
        )
      }
      return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
    })

    await Effect.runPromise(runAuthenticate("secret-token")(httpClient))

    expect(capturedAuth).toBe("Bearer secret-token")
  })

  it("sends Accept: application/json header", async () => {
    let capturedAccept: string | undefined
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/system/user/getInfo")) {
        capturedAccept = request.headers["accept"]
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              code: 200,
              data: { user: { userId: 9, nickName: "AcceptJson" } },
            }),
          ),
        )
      }
      if (url.pathname.endsWith("/system/user/getKnowledge")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ code: 200, data: { workspaces: [], permissions: {} } }),
          ),
        )
      }
      return Effect.die(new Error(`Unexpected request: ${url.pathname}`))
    })

    await Effect.runPromise(runAuthenticate("accept-test")(httpClient))

    expect(capturedAccept).toBe("application/json")
  })
})
