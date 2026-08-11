import { Cause, Effect, Layer, Encoding, Result } from "effect"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpRouter } from "effect/unstable/http"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { ExternalIdentity, ExternalIdentityAdapterTag } from "../auth/external-identity"

const BEARER_PREFIX = "knowledge:"

export class ExternalAuth extends HttpApiMiddleware.Service<ExternalAuth>()(
  "@opencode/ExternalAuth",
  { error: HttpApiError.UnauthorizedNoContent },
) {}

// The web UI sends the business JWT either as a raw Bearer token or in the
// "auth_token" encoding: base64("knowledge:<token>:"). Extract the raw token
// from either representation.
function decodeKnowledgeEncoded(value: string): string | undefined {
  const decodedResult = Encoding.decodeBase64String(value)
  if (!Result.isSuccess(decodedResult)) return undefined
  const decoded = decodedResult.success
  if (!decoded.startsWith(BEARER_PREFIX)) return undefined
  const rest = decoded.slice(BEARER_PREFIX.length)
  const endIdx = rest.indexOf(":")
  if (endIdx === -1) return undefined
  return rest.slice(0, endIdx)
}

// Extract Bearer token from request (URL query param or Authorization header)
export function extractBearerToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const url = new URL(request.url, "http://localhost")
  const queryAuth = url.searchParams.get("Authorization")
  if (queryAuth?.startsWith("Bearer ")) {
    const value = queryAuth.slice("Bearer ".length)
    return decodeKnowledgeEncoded(value) ?? value
  }

  const header = request.headers.authorization
  if (header?.startsWith("Bearer ")) {
    const value = header.slice("Bearer ".length)
    return decodeKnowledgeEncoded(value) ?? value
  }

  // Also handle auth_token encoded as Basic auth with "knowledge:" prefix
  if (header?.startsWith("Basic ")) {
    return decodeKnowledgeEncoded(header.slice("Basic ".length))
  }
  const authToken = url.searchParams.get("auth_token")
  if (authToken) {
    return decodeKnowledgeEncoded(authToken)
  }

  return undefined
}

// Encode a Bearer token into the auth_token format the web UI understands
export function encodeBearerToken(token: string): string {
  return Encoding.encodeBase64(`${BEARER_PREFIX}${token}:`)
}

export const externalAuthLayer = Layer.effect(
  ExternalAuth,
  Effect.gen(function* () {
    return ExternalAuth.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = extractBearerToken(request)
        const clientId = request.headers.clientid
        const path = new URL(request.url, "http://localhost").pathname

        if (!token) {
          yield* Effect.logInfo("external auth: no token, using anonymous identity", {
            path,
            hasAuthHeader: request.headers.authorization != null,
          })
          return yield* effect
        }
        console.log(`[external-auth] path=${path} token=${token.slice(0, 25)}... clientId=${clientId ?? ""}`)

        const maybeAdapter = yield* Effect.serviceOption(ExternalIdentityAdapterTag)
        if (maybeAdapter._tag === "None") {
          console.log(`[external-auth] no adapter, skipping identity resolution for ${path}`)
          return yield* effect
        }

        const info = yield* maybeAdapter.value.authenticate(token, clientId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("external auth: authenticate failed, using anonymous identity", {
              path,
              clientId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null as any)),
          ),
        )
        if (!info) {
          yield* Effect.logWarning("external auth: authenticate returned no identity", {
            path,
            clientId,
          })
          return yield* effect
        }

        yield* Effect.logInfo("external auth: identity resolved", {
          path,
          userId: info.userId || "",
          nickName: info.nickName || "",
          tenantId: info.tenantId || "",
          workspaceCount: (info.workspaces ?? []).length,
        })

        return yield* effect.pipe(
          Effect.provideService(ExternalIdentity, ExternalIdentity.of(info)),
        )
      }),
    )
  }),
)

// Router-level middleware for static UI route authentication
export const externalAuthRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = extractBearerToken(request)
        if (!token) return yield* effect

        const maybeAdapter = yield* Effect.serviceOption(ExternalIdentityAdapterTag)
        if (maybeAdapter._tag === "None") return yield* effect

        return yield* maybeAdapter.value.authenticate(token, request.headers.clientid).pipe(
          Effect.flatMap((info) =>
            effect.pipe(Effect.provideService(ExternalIdentity, ExternalIdentity.of(info))),
          ),
          Effect.catchCause(() => Effect.fail(new HttpApiError.Unauthorized({}))),
        )
      })
  }),
)
