import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { ExternalIdentityAdapter } from "@opencode-ai/server/auth/external-identity"
import { ExternalIdentityAdapterTag, ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { ExternalAuthConfig } from "@opencode-ai/server/auth/external-config"

// -- Types for business system API responses --

interface ApiResponse<T = unknown> {
  code: number
  msg?: string
  data?: T
}

interface KnowledgeInfoData {
  currentWorkspaceId?: string
  workspaces?: Array<{
    workspaceId: string
    workspaceName: string
    workspaceType?: string
    description?: string
    llmPath?: string
    categories: Array<{
      categoryId: string
      categoryName: string
      parentId?: string
      sort: number
    }>
  }>
  permissions?: Record<string, string[]>
}

interface DecodedUserInfo {
  userId: number
  userName: string
  tenantId: string
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

// -- JWT helpers --

function decodeClientIdFromToken(token: string): string | undefined {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return undefined
    // JWT uses base64url → convert to standard base64 + fix padding
    let base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/")
    while (base64.length % 4) base64 += "="
    const payload = JSON.parse(Buffer.from(base64, "base64").toString())
    return payload.clientid ?? payload.clientId
  } catch {
    return undefined
  }
}

// Decode user info from the JWT payload directly — the business system's
// JWT already carries userId, userName, and tenantId in its claims, so we
// skip calling the getInfo API (which requires a Sa-Token session the JWT
// can't satisfy).
function decodeUserInfoFromToken(token: string): DecodedUserInfo | undefined {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return undefined
    let base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/")
    while (base64.length % 4) base64 += "="
    const payload = JSON.parse(Buffer.from(base64, "base64").toString())
    if (payload.userId && payload.userName) {
      return {
        userId: payload.userId,
        userName: payload.userName,
        tenantId: payload.tenantId ?? "000000",
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

// -- API calls --

function callGetKnowledge(
  httpClient: HttpClient.HttpClient,
  baseUrl: string,
  token: string,
  clientId?: string,
): Effect.Effect<KnowledgeInfoData> {
  return Effect.gen(function* () {
    const headers: Record<string, string> = {}
    if (clientId) {
      headers["Clientid"] = clientId
    }

    const apiUrl = `${baseUrl.trim()}/system/user/getKnowledge`
    console.log("[knowledge-adapter] 调业务API:", apiUrl)
    console.log("[knowledge-adapter] token前20字符:", token.substring(0, 20) + "...")

    const response =
      yield *
      httpClient.execute(
        HttpClientRequest.get(apiUrl).pipe(
          // 业务系统 getKnowledge 要求 Authorization 头携带 Bearer 前缀的 JWT
          HttpClientRequest.setHeader("Authorization", "Bearer " + token),
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.acceptJson,
        ),
      )

    const body = (yield* response.json) as unknown as ApiResponse<KnowledgeInfoData>
    console.log(
      "[knowledge-adapter] 业务API响应:",
      JSON.stringify({ code: body.code, workspaces: body.data?.workspaces?.length ?? 0 }),
    )

    if (body.code !== 200) {
      console.log("[knowledge-adapter] 业务API返回非200:", JSON.stringify(body))
      return { workspaces: [], permissions: {} }
    }

    return body.data ?? { workspaces: [], permissions: {} }
  }).pipe(
    Effect.option,
    Effect.map((maybe) =>
      maybe._tag === "Some" ? maybe.value : ({ workspaces: [], permissions: {} } as KnowledgeInfoData),
    ),
  )
}

// -- Layer --

export const KnowledgeAdapterLayer = Layer.effect(
  ExternalIdentityAdapterTag,
  Effect.gen(function* () {
    const config = yield* ExternalAuthConfig
    const httpClient = yield* HttpClient.HttpClient

    const authenticate: ExternalIdentityAdapter["authenticate"] = (token, clientId?) =>
      Effect.gen(function* () {
        // Check cache
        const key = cacheKey(token)
        const cached = identityCache.get(key)
        if (cached && cached.expiresAt > Date.now()) {
          return cached.identity
        }

        // Decode user info from JWT payload directly (no backend API call)
        const decoded = decodeUserInfoFromToken(token)
        if (!decoded) {
          return ExternalIdentityInfo.make({
            userId: "",
            nickName: "",
            tenantId: "000000",
            workspaces: [],
            permissions: {},
          })
        }

        // Try fetching workspaces from business system; callGetKnowledge already
        // handles all errors internally (Effect.option → empty on failure).
        const resolvedClientId = clientId ?? decodeClientIdFromToken(token)
        const knowledgeInfo = yield* callGetKnowledge(
          httpClient, config.apiBaseUrl, token, resolvedClientId,
        )

        const identity = ExternalIdentityInfo.make({
          userId: String(decoded.userId),
          nickName: decoded.userName,
          tenantId: decoded.tenantId,
          workspaces: (knowledgeInfo.workspaces ?? []).map((w) => ({
            workspaceId: w.workspaceId,
            workspaceName: w.workspaceName,
            workspaceType: w.workspaceType ?? undefined,
            description: w.description ?? undefined,
            llmPath: w.llmPath ?? undefined,
            categories: (w.categories ?? []).map((c) => ({
              categoryId: c.categoryId,
              categoryName: c.categoryName,
              parentId: c.parentId ?? undefined,
              sort: c.sort,
            })),
          })),
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
