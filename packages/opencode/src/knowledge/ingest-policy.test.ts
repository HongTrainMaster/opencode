import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  MAX_INGEST_POLICY_PARENT_DEPTH,
  externalUserIdOf,
  ingestAdminUserIds,
  ingestPolicyPrompt,
  isIngestAdmin,
  resolveIngestActor,
  sessionIngestPolicy,
} from "./ingest-policy"

// 环境变量是进程级的，保存/恢复避免与其它测试文件互相污染
let previousAdminIds: string | undefined
beforeEach(() => {
  previousAdminIds = process.env.KNOWLEDGE_INGEST_ADMIN_USERIDS
  delete process.env.KNOWLEDGE_INGEST_ADMIN_USERIDS
})
afterEach(() => {
  if (previousAdminIds === undefined) delete process.env.KNOWLEDGE_INGEST_ADMIN_USERIDS
  else process.env.KNOWLEDGE_INGEST_ADMIN_USERIDS = previousAdminIds
})

describe("ingestAdminUserIds", () => {
  it("defaults to user 1 when unset", () => {
    expect(ingestAdminUserIds()).toEqual(["1"])
    expect(isIngestAdmin("1")).toBe(true)
    expect(isIngestAdmin("2")).toBe(false)
    expect(isIngestAdmin(undefined)).toBe(false)
  })

  it("accepts a comma-separated list and ignores blanks", () => {
    process.env.KNOWLEDGE_INGEST_ADMIN_USERIDS = " 1, 42 ,, 1966044826377150466 "
    expect(ingestAdminUserIds()).toEqual(["1", "42", "1966044826377150466"])
    expect(isIngestAdmin("42")).toBe(true)
    expect(isIngestAdmin("1966044826377150466")).toBe(true)
  })

  it("fails closed when configured empty", () => {
    process.env.KNOWLEDGE_INGEST_ADMIN_USERIDS = ""
    expect(ingestAdminUserIds()).toEqual([])
    expect(isIngestAdmin("1")).toBe(false)
  })
})

describe("resolveIngestActor", () => {
  it("treats sessions without an external user as internal (headless wiki/ppt/ingest sessions)", () => {
    expect(resolveIngestActor(undefined)).toBe("internal")
    expect(resolveIngestActor({})).toBe("internal")
    expect(resolveIngestActor({ externalUserId: "" })).toBe("internal")
    expect(resolveIngestActor({ externalUserId: 1 })).toBe("internal")
  })

  it("allows the admin user (userId=1) to ingest", () => {
    expect(resolveIngestActor({ externalUserId: "1" })).toBe("admin")
  })

  it("restricts every other external user", () => {
    expect(resolveIngestActor({ externalUserId: "2" })).toBe("restricted")
    expect(resolveIngestActor({ externalUserId: "1966044826377150466" })).toBe("restricted")
  })

  it("honours the KNOWLEDGE_INGEST_ADMIN_USERIDS override", () => {
    process.env.KNOWLEDGE_INGEST_ADMIN_USERIDS = "42"
    expect(resolveIngestActor({ externalUserId: "42" })).toBe("admin")
    expect(resolveIngestActor({ externalUserId: "1" })).toBe("restricted")
  })
})

describe("externalUserIdOf", () => {
  it("reads the external user id from session metadata", () => {
    expect(externalUserIdOf({ externalUserId: "1", externalTenantId: "000000" })).toBe("1")
    expect(externalUserIdOf({ externalTenantId: "000000" })).toBeUndefined()
    expect(externalUserIdOf(undefined)).toBeUndefined()
  })
})

describe("ingestPolicyPrompt", () => {
  it("injects nothing for the admin or for internal headless sessions", () => {
    expect(ingestPolicyPrompt("admin", "1")).toBeUndefined()
    expect(ingestPolicyPrompt("internal")).toBeUndefined()
  })

  it("tells restricted users' sessions to refuse ingest with an explicit message", () => {
    const prompt = ingestPolicyPrompt("restricted", "2")
    expect(prompt).toBeDefined()
    expect(prompt).toContain("无权限：知识入库仅限管理员（userId=1）操作")
    expect(prompt).toContain("userId=2")
    expect(prompt).toContain("llm-wiki 的 ingest")
    expect(prompt).toContain("wiki/sources/")
    // 只读能力仍需保留
    expect(prompt).toContain("只读能力不受限制")
  })

  it("uses the overridden admin id in the refusal message", () => {
    process.env.KNOWLEDGE_INGEST_ADMIN_USERIDS = "42"
    expect(ingestPolicyPrompt("restricted", "2")).toContain("userId=42")
  })
})

describe("sessionIngestPolicy", () => {
  type Node = { metadata?: Record<string, unknown>; parentID?: string }
  const withParents = (nodes: Record<string, Node>) => (id: string): Effect.Effect<Node | undefined> =>
    Effect.succeed(nodes[id])

  const policyOf = (
    session: Node,
    nodes: Record<string, Node> = {},
  ): Promise<string | undefined> => Effect.runPromise(sessionIngestPolicy(session, withParents(nodes)))

  it("injects nothing for the admin's own session", async () => {
    expect(await policyOf({ metadata: { externalUserId: "1" } })).toBeUndefined()
  })

  it("injects the refusal policy for a restricted user's session", async () => {
    const policy = await policyOf({ metadata: { externalUserId: "1966044826377150466" } })
    expect(policy).toContain("无权限：知识入库仅限管理员（userId=1）操作")
  })

  it("keeps internal headless sessions (no externalUser, no parent) unrestricted", async () => {
    expect(await policyOf({})).toBeUndefined()
    expect(await policyOf({ metadata: {} })).toBeUndefined()
  })

  it("inherits the restriction through subagent sessions", async () => {
    // 子会话自身无 externalUserId，属主在两层之上
    const nodes = {
      ses_sub: { parentID: "ses_user" },
      ses_user: { metadata: { externalUserId: "2" } },
    }
    const policy = await policyOf({ parentID: "ses_sub" }, nodes)
    expect(policy).toContain("无权限：知识入库仅限管理员（userId=1）操作")
  })

  it("inherits the admin allowance through subagent sessions", async () => {
    const nodes = { ses_user: { metadata: { externalUserId: "1" } } }
    expect(await policyOf({ parentID: "ses_user" }, nodes)).toBeUndefined()
  })

  it("stops walking past a missing parent or the depth limit, treating it as internal", async () => {
    expect(await policyOf({ parentID: "ses_missing" })).toBeUndefined()
    const chain: Record<string, Node> = {}
    for (let i = 0; i < MAX_INGEST_POLICY_PARENT_DEPTH + 3; i++) chain[`ses_${i}`] = { parentID: `ses_${i + 1}` }
    // 第 9 层才出现属主：超出深度上限 → 不再继承，按内部会话处理
    chain[`ses_${MAX_INGEST_POLICY_PARENT_DEPTH + 2}`] = { metadata: { externalUserId: "2" } }
    expect(await policyOf({ parentID: "ses_0" }, chain)).toBeUndefined()
  })
})
