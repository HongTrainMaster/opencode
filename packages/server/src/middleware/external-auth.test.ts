import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as HttpServerRequestModule from "effect/unstable/http/HttpServerRequest"
import {
  ExternalIdentity,
  ExternalIdentityAdapterTag,
  type ExternalIdentityAdapter,
} from "../auth/external-identity"
import { ExternalAuth, externalAuthLayer, extractBearerToken, encodeBearerToken } from "./external-auth"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"

const testIdentity = ExternalIdentity.Info.make({
  userId: "test-user",
  nickName: "Test User",
  tenantId: "test-tenant",
  workspaces: [],
  permissions: {},
})

function makeMockAdapter(expectedToken: string): ExternalIdentityAdapter {
  return {
    authenticate: (token: string, _clientId?: string) => {
      if (token !== expectedToken) {
        return Effect.fail(new UnauthorizedError({ message: "Invalid token" }))
      }
      return Effect.succeed(testIdentity)
    },
  }
}

describe("encodeBearerToken", () => {
  it("encodes a token with the knowledge: prefix", () => {
    const encoded = encodeBearerToken("my-token")
    expect(encoded).toBe("a25vd2xlZGdlOm15LXRva2VuOg==")
  })
})

describe("extractBearerToken", () => {
  it("extracts Bearer token from URL query parameter", () => {
    const request = HttpServerRequestModule.fromWeb(
      new Request("http://localhost/test?Authorization=Bearer%20valid-token"),
    )
    expect(extractBearerToken(request)).toBe("valid-token")
  })

  it("extracts Bearer token from Authorization header", () => {
    const request = HttpServerRequestModule.fromWeb(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer header-token" },
      }),
    )
    expect(extractBearerToken(request)).toBe("header-token")
  })

  it("returns undefined when no Bearer token is present", () => {
    const request = HttpServerRequestModule.fromWeb(
      new Request("http://localhost/test"),
    )
    expect(extractBearerToken(request)).toBeUndefined()
  })

  it("extracts token from auth_token query param with knowledge: prefix", () => {
    // auth_token param contains knowledge:token: base64-encoded
    const authToken = encodeBearerToken("knowledge-token")
    const request = HttpServerRequestModule.fromWeb(
      new Request(`http://localhost/test?auth_token=${authToken}`),
    )
    expect(extractBearerToken(request)).toBe("knowledge-token")
  })
})

describe("ExternalAuthMiddleware", () => {
  it("injects ExternalIdentity for valid Bearer token in URL", () => {
    const adapter = makeMockAdapter("valid-token")
    const request = HttpServerRequestModule.fromWeb(
      new Request("http://localhost/test?Authorization=Bearer%20valid-token"),
    )

    const result = Effect.runSync(
      Effect.gen(function* () {
        const middleware: any = yield* ExternalAuth
        const innerEffect = Effect.gen(function* () {
          const identity = yield* ExternalIdentity
          return identity.userId
        })
        return yield* (middleware as any)(innerEffect)
      }).pipe(
        Effect.provideService(HttpServerRequestModule.HttpServerRequest as any, request),
        Effect.provide(externalAuthLayer),
        Effect.provideService(ExternalIdentityAdapterTag as any, adapter),
      ),
    )

    expect(result).toBe("test-user")
  })

  it("injects ExternalIdentity for valid Bearer token in header", () => {
    const adapter = makeMockAdapter("header-token")
    const request = HttpServerRequestModule.fromWeb(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer header-token" },
      }),
    )

    const result = Effect.runSync(
      Effect.gen(function* () {
        const middleware: any = yield* ExternalAuth
        const innerEffect = Effect.gen(function* () {
          const identity = yield* ExternalIdentity
          return identity.userId
        })
        return yield* (middleware as any)(innerEffect)
      }).pipe(
        Effect.provideService(HttpServerRequestModule.HttpServerRequest as any, request),
        Effect.provide(externalAuthLayer),
        Effect.provideService(ExternalIdentityAdapterTag as any, adapter),
      ),
    )

    expect(result).toBe("test-user")
  })

  it("passes through when no Bearer token is present", () => {
    const adapter = makeMockAdapter("valid-token")
    const request = HttpServerRequestModule.fromWeb(
      new Request("http://localhost/test"),
    )

    const result = Effect.runSync(
      Effect.gen(function* () {
        const middleware: any = yield* ExternalAuth
        const innerEffect = Effect.gen(function* () {
          const identity = yield* Effect.serviceOption(ExternalIdentity)
          return identity._tag
        })
        return yield* (middleware as any)(innerEffect)
      }).pipe(
        Effect.provideService(HttpServerRequestModule.HttpServerRequest as any, request),
        Effect.provide(externalAuthLayer),
        Effect.provideService(ExternalIdentityAdapterTag as any, adapter),
      ),
    )

    expect(result).toBe("None")
  })

  it("throws Unauthorized error for invalid token", () => {
    const adapter = makeMockAdapter("valid-token")
    const request = HttpServerRequestModule.fromWeb(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer invalid-token" },
      }),
    )

    expect(() =>
      Effect.runSync(
        Effect.gen(function* () {
          const middleware: any = yield* ExternalAuth
          const innerEffect = Effect.gen(function* () {
            return "should not reach here"
          })
          return yield* (middleware as any)(innerEffect)
        }).pipe(
          Effect.provideService(HttpServerRequestModule.HttpServerRequest as any, request),
          Effect.provide(externalAuthLayer),
          Effect.provideService(ExternalIdentityAdapterTag as any, adapter),
        ),
      ),
    ).toThrow()
  })
})
