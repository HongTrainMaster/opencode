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
 * 支持 `Authorization` 与 `auth_token` 两个参数，返回 `Authorization: Bearer <jwt>`。
 */
function knowledgeAuthHeader(): Record<string, string> | undefined {
  if (typeof location === "undefined") return undefined
  const params = new URLSearchParams(location.search)
  const token = params.get("Authorization") ?? params.get("auth_token")
  if (!token) return undefined
  return { Authorization: `Bearer ${token}` }
}

export type ServerApi = OpenCodeClient
