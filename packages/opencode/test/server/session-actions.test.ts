import { afterEach, describe, expect, mock } from "bun:test"
import { createHmac } from "node:crypto"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(SessionNs.node),
    httpApiLayer,
  ),
)

// -- 知识库隔离测试辅助：真实 HS256 签名 JWT + knowledgeMode env 开关 --
// 服务器实时读取 process.env（isKnowledgeMode / KNOWLEDGE_JWT_SECRET），
// 测试在用例内开启 knowledgeMode，afterEach 清理。

const SECRET = "test-jwt-secret"

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url")
}

function signJwt(payload: Record<string, unknown>, secret = SECRET): string {
  const signingInput = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}`
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url")
  return `${signingInput}.${sig}`
}

function enableKnowledgeMode() {
  process.env.KNOWLEDGE_SESSION_ISOLATION = "true"
  process.env.KNOWLEDGE_JWT_SECRET = SECRET
}

function authHeaders(userId: number, userName: string, tenantId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${signJwt({ userId, userName, tenantId })}`,
  }
}

afterEach(async () => {
  delete process.env.KNOWLEDGE_SESSION_ISOLATION
  delete process.env.KNOWLEDGE_JWT_SECRET
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  it.instance(
    "session routes expose metadata on create, update, get, and fork",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "meta-session",
            metadata: { source: "sdk", trace: { id: "abc" } },
          }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata).toEqual({ source: "sdk", trace: { id: "abc" } })

        const updated = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { source: "sdk", trace: { id: "def" }, tags: ["one"] } }),
        })
        expect(updated.status).toBe(200)

        const next = (yield* updated.json) as SessionNs.Info
        expect(next.metadata).toEqual({ source: "sdk", trace: { id: "def" }, tags: ["one"] })

        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).metadata).toEqual(next.metadata)

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)

        const fork = (yield* forked.json) as SessionNs.Info
        expect(fork.metadata).toEqual(next.metadata)

        const reset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: {} }),
        })
        expect(reset.status).toBe(200)
        expect(((yield* reset.json) as SessionNs.Info).metadata).toEqual({})

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "abort route returns success",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/session/${session.id}/abort`, test.directory, { method: "POST" })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "native create injects external identity metadata for authenticated knowledge users",
    () =>
      Effect.gen(function* () {
        enableKnowledgeMode()
        const test = yield* TestInstance

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers: authHeaders(1001, "Alice", "tenant_01"),
          body: JSON.stringify({ title: "kb-session" }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata?.externalUserId).toBe("1001")
        expect(session.metadata?.externalTenantId).toBe("tenant_01")

        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "knowledge mode isolates session list per user (A never sees B's sessions)",
    () =>
      Effect.gen(function* () {
        enableKnowledgeMode()
        const test = yield* TestInstance

        const create = (userId: number, userName: string, title: string) =>
          requestInDirectory("/session", test.directory, {
            method: "POST",
            headers: authHeaders(userId, userName, "tenant_01"),
            body: JSON.stringify({ title }),
          }).pipe(
            Effect.flatMap((res) => res.json),
            Effect.map((json) => json as unknown as SessionNs.Info),
          )
        const a = yield* create(1, "A", "session-of-A")
        const b = yield* create(2, "B", "session-of-B")

        const listAs = (userId: number, userName: string) =>
          requestInDirectory("/session", test.directory, {
            headers: authHeaders(userId, userName, "tenant_01"),
          }).pipe(
            Effect.flatMap((res) => res.json),
            Effect.map((json) => (json as unknown as SessionNs.Info[]).map((s) => s.title)),
          )

        const titlesA = yield* listAs(1, "A")
        expect(titlesA).toContain("session-of-A")
        expect(titlesA).not.toContain("session-of-B")

        const titlesB = yield* listAs(2, "B")
        expect(titlesB).toContain("session-of-B")
        expect(titlesB).not.toContain("session-of-A")

        yield* SessionNs.Service.use((svc) =>
          Effect.forEach([a.id, b.id], (id) => svc.remove(id).pipe(Effect.ignore)),
        )
      }),
    { git: true },
  )

  it.instance(
    "knowledge mode denies anonymous and cross-user direct access to a session",
    () =>
      Effect.gen(function* () {
        enableKnowledgeMode()
        const test = yield* TestInstance
        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers: authHeaders(1001, "Alice", "tenant_01"),
          body: JSON.stringify({ title: "alice-secret" }),
        })
        expect(created.status).toBe(200)
        const session = (yield* created.json) as SessionNs.Info

        // 匿名：列表为空、直接访问 401、创建 401。
        const anonList = yield* requestInDirectory("/session", test.directory)
        expect(anonList.status).toBe(200)
        expect((yield* anonList.json) as unknown as SessionNs.Info[]).toEqual([])

        const anonGet = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(anonGet.status).toBe(401)

        const anonCreate = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "anon" }),
        })
        expect(anonCreate.status).toBe(401)

        // 跨用户：B 访问 A 的会话 → 401；fork 也 401。
        const bGet = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          headers: authHeaders(2002, "Bob", "tenant_01"),
        })
        expect(bGet.status).toBe(401)

        const bFork = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers: authHeaders(2002, "Bob", "tenant_01"),
          body: JSON.stringify({}),
        })
        expect(bFork.status).toBe(401)

        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "experimental background route is a no-op without synchronous subagents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/experimental/session/${session.id}/background`, test.directory, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(false)
      }),
    { git: true },
  )
})
