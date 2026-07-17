import { Effect, Layer, Encoding, Result } from "effect"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpRouter } from "effect/unstable/http"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { ExternalIdentity, ExternalIdentityAdapterTag } from "../auth/external-identity"

const BEARER_PREFIX = "knowledge:"

export class ExternalAuth extends HttpApiMiddleware.Service<ExternalAuth>()(
  "@opencode/ExternalAuth",
  { error: HttpApiError.UnauthorizedNoContent },
) {}

// Extract Bearer token from request (URL query param or Authorization header)
export function extractBearerToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const url = new URL(request.url, "http://localhost")
  const queryAuth = url.searchParams.get("Authorization")
  if (queryAuth?.startsWith("Bearer ")) return queryAuth.slice("Bearer ".length)

  const header = request.headers.authorization
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length)

  // Also handle auth_token encoded as Basic auth with "knowledge:" prefix
  if (header?.startsWith("Basic ")) {
    const decodedResult = Encoding.decodeBase64String(header.slice("Basic ".length))
    if (Result.isSuccess(decodedResult)) {
      const decoded = decodedResult.success
      // Format: "knowledge:TOKEN:"
      if (decoded.startsWith(BEARER_PREFIX)) {
        const rest = decoded.slice(BEARER_PREFIX.length)
        const endIdx = rest.indexOf(":")
        if (endIdx !== -1) {
          return rest.slice(0, endIdx)
        }
      }
    }
  }
  const authToken = url.searchParams.get("auth_token")
  if (authToken) {
    const decodedResult = Encoding.decodeBase64String(authToken)
    if (Result.isSuccess(decodedResult)) {
      const decoded = decodedResult.success
      // Format: "knowledge:TOKEN:"
      if (decoded.startsWith(BEARER_PREFIX)) {
        const rest = decoded.slice(BEARER_PREFIX.length)
        const endIdx = rest.indexOf(":")
        if (endIdx !== -1) {
          return rest.slice(0, endIdx)
        }
      }
    }
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
        if (!token) return yield* effect

        const maybeAdapter = yield* Effect.serviceOption(ExternalIdentityAdapterTag)
        if (maybeAdapter._tag === "None") return yield* effect

        return yield* maybeAdapter.value.authenticate(token).pipe(
          Effect.flatMap((identity) =>
            effect.pipe(Effect.provideService(ExternalIdentity, identity)),
          ),
          Effect.catchCause(() => Effect.fail(new HttpApiError.Unauthorized({}))),
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

        return yield* maybeAdapter.value.authenticate(token).pipe(
          Effect.flatMap((identity) =>
            effect.pipe(Effect.provideService(ExternalIdentity, identity)),
          ),
          Effect.catchCause(() => Effect.fail(new HttpApiError.Unauthorized({}))),
        )
      })
  }),
)
