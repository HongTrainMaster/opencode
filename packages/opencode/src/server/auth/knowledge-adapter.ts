import { Effect, Layer } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { ExternalIdentityAdapterTag, ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { ExternalAuthConfig } from "@opencode-ai/server/auth/external-config"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"

// -- Types for business system API responses --

interface ApiResponse<T = unknown> {
  code: number
  msg?: string
  data?: T
}

interface UserInfoData {
  user: {
    userId: number | string
    nickName: string
    tenantId?: string
  }
}

interface KnowledgeInfoData {
  currentWorkspaceId?: string
  workspaces?: Array<{
    id: string
    name: string
    categories: Array<{
      categoryId: string
      categoryName: string
      parentId?: string
      sort: number
    }>
  }>
  permissions?: Record<string, string[]>
}

// -- In-memory cache with 5-minute TTL --

const identityCache = new Map<string, { identity: ExternalIdentityInfo; expiresAt: number }>()
const CACHE_TTL = 5 * 60 * 1000

function cacheKey(token: string): string {
  let hash = 0
  for (let i = 0; i < Math.min(token.length, 64); i++) {
    hash = ((hash << 5) - hash) + token.charCodeAt(i)
    hash |= 0
  }
  return String(hash)
}

// -- API calls --

function callGetInfo(
  httpClient: HttpClient.HttpClient,
  baseUrl: string,
  token: string,
  clientId?: string,
): Effect.Effect<UserInfoData, UnauthorizedError> {
  return Effect.gen(function* () {
    const headers: Record<string, string> = {}
    if (clientId) {
      headers["clientid"] = clientId
    }

    const response = yield* httpClient.execute(
      HttpClientRequest.get(`${baseUrl}/system/user/getInfo`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.acceptJson,
      ),
    )

    const body = (yield* response.json) as unknown as ApiResponse<UserInfoData>

    if (body.code !== 200) {
      return yield* new UnauthorizedError({ message: body.msg ?? "Authentication failed" })
    }
    if (!body.data) {
      return yield* new UnauthorizedError({ message: "Authentication failed: no user data" })
    }

    return body.data
  }).pipe(
    Effect.mapError((error) => {
      if (error instanceof UnauthorizedError) return error
      return new UnauthorizedError({ message: "HTTP request failed" })
    }),
  )
}

function callGetKnowledge(
  httpClient: HttpClient.HttpClient,
  baseUrl: string,
  token: string,
): Effect.Effect<KnowledgeInfoData> {
  return Effect.gen(function* () {
    const response = yield* httpClient.execute(
      HttpClientRequest.get(`${baseUrl}/system/user/getKnowledge`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.acceptJson,
      ),
    )

    const body = (yield* response.json) as unknown as ApiResponse<KnowledgeInfoData>

    if (body.code !== 200) {
      return { workspaces: [], permissions: {} }
    }

    return body.data ?? { workspaces: [], permissions: {} }
  }).pipe(
    Effect.option,
    Effect.map((maybe) => maybe._tag === "Some" ? maybe.value : { workspaces: [], permissions: {} } as KnowledgeInfoData),
  )
}

// -- Layer --

export const KnowledgeAdapterLayer = Layer.effect(
  ExternalIdentityAdapterTag,
  Effect.gen(function* () {
    const config = yield* ExternalAuthConfig
    const httpClient = yield* HttpClient.HttpClient

    const authenticate = (token: string, clientId?: string) =>
      Effect.gen(function* () {
        // Check cache
        const key = cacheKey(token)
        const cached = identityCache.get(key)
        if (cached && cached.expiresAt > Date.now()) {
          return cached.identity
        }

        // Fetch identity and knowledge info in parallel
        const [userInfo, knowledgeInfo] = yield* Effect.all(
          [
            callGetInfo(httpClient, config.apiBaseUrl, token, clientId),
            callGetKnowledge(httpClient, config.apiBaseUrl, token),
          ],
          { concurrency: 2 },
        )

        const identity = ExternalIdentityInfo.make({
          userId: String(userInfo.user.userId),
          nickName: userInfo.user.nickName,
          tenantId: userInfo.user.tenantId ?? "000000",
          workspaces: knowledgeInfo.workspaces ?? [],
          permissions: knowledgeInfo.permissions ?? {},
        })

        // Cache the identity
        identityCache.set(key, { identity, expiresAt: Date.now() + CACHE_TTL })

        // Cleanup stale entries if cache is too large
        if (identityCache.size > 1000) {
          const now = Date.now()
          for (const [k, v] of identityCache) {
            if (v.expiresAt <= now) identityCache.delete(k)
          }
        }

        return identity
      })

    return { authenticate }
  }),
)
