import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { ExternalIdentityAdapter } from "@opencode-ai/server/auth/external-identity"
import { ExternalIdentityAdapterTag, ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { ExternalAuthConfig } from "@opencode-ai/server/auth/external-config"
import { verifyJwt, hasJwtVerificationConfig, type JwtVerifierConfig } from "@opencode-ai/server/auth/jwt-verify"

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
  userId: string
  userName: string
  tenantId: string
}

// -- In-memory cache with 5-minute TTL --

const identityCache = new Map<string, { identity: ExternalIdentityInfo; expiresAt: number }>()
const CACHE_TTL = 5 * 60 * 1000

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

/**
 * Verify the JWT signature and temporal claims, then read the user identity
 * from the verified payload. Returns `undefined` (fail-closed) when:
 *   - no verification key is configured (KNOWLEDGE_JWT_SECRET/PUBLIC_KEY/JWKS)
 *   - the signature does not match / the token is tampered
 *   - the token is expired or not-yet-valid
 * The business system's JWT is an HS256 token signed with sa-token's
 * `jwt-secret-key`; it carries userId/userName/tenantId in its claims.
 *
 * Verification key material is read live from process.env so deployments and
 * tests can configure/override it without rebuilding layers.
 */
async function decodeUserInfoFromVerifiedToken(token: string): Promise<DecodedUserInfo | undefined> {
  const verifierConfig: JwtVerifierConfig = {
    secret: process.env.KNOWLEDGE_JWT_SECRET,
    publicKeyPem: process.env.KNOWLEDGE_JWT_PUBLIC_KEY,
    jwksUrl: process.env.KNOWLEDGE_JWT_JWKS_URL,
  }
  if (!hasJwtVerificationConfig(verifierConfig)) {
    return undefined
  }
  const verified = await verifyJwt(token, verifierConfig)
  if (!verified) return undefined
  const payload = verified.payload
  // userId/userName/tenantId 来自已验证的 payload。注意：业务系统 user_id 是
  // 19 位大整数（> 2^53），JWT payload 里以 JSON number 表示，JS JSON.parse 会
  // 丢失精度。因此优先用 loginId（"sys_user:1966044826377150466"，字符串，无精度
  // 损失）提取精确 userId；仅当 loginId 不可用时回退到 payload.userId。
  const loginIdUserId = extractUserIdFromLoginId(payload)
  const userId = loginIdUserId ?? payload.userId
  if (userId && payload.userName) {
    return {
      userId: String(userId),
      userName: String(payload.userName),
      tenantId: String(payload.tenantId ?? "000000"),
    }
  }
  return undefined
}

/** 从 sa-token 的 loginId（"sys_user:1966044826377150466"）提取精确 userId。 */
function extractUserIdFromLoginId(payload: Record<string, unknown>): string | undefined {
  const loginId = payload.loginId
  if (typeof loginId !== "string") return undefined
  const sep = loginId.lastIndexOf(":")
  return sep === -1 ? undefined : loginId.slice(sep + 1)
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
        console.log(`[knowledge-adapter] authenticate called token=${token.slice(0, 25)}... clientId=${clientId ?? ""}`)
        // Check cache (keyed by the full token; the token is the proof of
        // identity, so the raw string is the correct cache key).
        const key = token
        const cached = identityCache.get(key)
        if (cached && cached.expiresAt > Date.now()) {
          console.log(`[knowledge-adapter] cache hit userId=${cached.identity.userId}`)
          return cached.identity
        }
        console.log(`[knowledge-adapter] cache miss`)

        // Verify signature + exp/nbf first. Unverifiable tokens never yield a
        // real identity (fail-closed).
        const decoded = yield* Effect.promise(() => decodeUserInfoFromVerifiedToken(token))
        if (!decoded) {
          yield* Effect.logWarning(
            "knowledge adapter: JWT verification failed (no key configured, tampered, or expired) — using empty identity (fail-closed)",
            { clientId },
          )
          return ExternalIdentityInfo.make({
            userId: "",
            nickName: "",
            tenantId: "000000",
            workspaces: [],
            permissions: {},
          })
        }
        yield* Effect.logInfo("knowledge adapter: JWT verified", {
          userId: decoded.userId,
          userName: decoded.userName,
          tenantId: decoded.tenantId,
        })
        console.log(`[knowledge-adapter] JWT verified userId=${decoded.userId} userName=${decoded.userName} tenantId=${decoded.tenantId}`)

        // Fetch workspaces from business system; callGetKnowledge already
        // handles all errors internally (Effect.option → empty on failure).
        const resolvedClientId = clientId ?? decodeClientIdFromToken(token)
        const knowledgeInfo = yield* callGetKnowledge(
          httpClient, config.apiBaseUrl, token, resolvedClientId,
        )

        const identity = ExternalIdentityInfo.make({
          userId: decoded.userId,
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
