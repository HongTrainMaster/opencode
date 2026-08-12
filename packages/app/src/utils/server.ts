import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()
  // 知识库 iframe 场景：URL 携带业务系统 JWT（Authorization / auth_token 参数），
  // 附加到 SDK 请求头，供后端 ExternalAuth 解析出用户身份（按用户隔离历史会话）。
  const knowledgeAuth = knowledgeAuthHeader()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
      ...knowledgeAuth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers: {
      ...(input.server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({
              username: input.server.username,
              password: input.server.password,
            })}`,
          }
        : {}),
      ...knowledgeAuthHeader(),
    },
  })
}

/**
 * 知识库嵌入场景（iframe）：从当前 URL query 读取业务系统 JWT。
 * 支持 `Authorization` 与 `auth_token` 两个参数，URL 缺失时回退到
 * sessionStorage 中持久化的 token（entry.tsx 进入时写入），保证跨路由
 * （会话页、SDK 请求）都携带身份。返回 `Authorization: Bearer <jwt>`。
 * token 可能已带 "Bearer " 前缀（业务系统 URL 传的是完整 Authorization 值），
 * 这里归一化避免出现 "Bearer Bearer ..."。
 */
function knowledgeAuthHeader(): Record<string, string> | undefined {
  if (typeof location === "undefined") return undefined
  const params = new URLSearchParams(location.search)
  const token =
    params.get("Authorization") ??
    params.get("auth_token") ??
    (typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem("opencode_knowledge_token")
      : undefined)
  if (!token) return undefined
  const normalized = token.startsWith("Bearer ") ? token.slice("Bearer ".length) : token
  return { Authorization: `Bearer ${normalized}` }
}

export type ServerApi = OpenCodeClient
