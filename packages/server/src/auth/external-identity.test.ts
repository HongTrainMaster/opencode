import { describe, expect, it } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { ExternalIdentity, ExternalIdentityInfo, type ExternalIdentityAdapter } from "./external-identity"

describe("ExternalIdentity", () => {
  it("creates an identity", () => {
    const info = ExternalIdentity.Info.make({
      userId: "42",
      nickName: "管理员",
      tenantId: "000000",
      workspaces: [
        { id: "kb_001", name: "产品知识库", categories: [] },
      ],
      permissions: { kb_001: ["read", "write"] },
    })
    expect(info.userId).toBe("42")
    expect(info.tenantId).toBe("000000")
    expect(info.nickName).toBe("管理员")
    expect(info.workspaces).toHaveLength(1)
    expect(info.workspaces[0].id).toBe("kb_001")
    expect(info.permissions["kb_001"]).toEqual(["read", "write"])
  })

  it("works with empty workspaces", () => {
    const info = ExternalIdentity.Info.make({
      userId: "1",
      nickName: "test",
      tenantId: "000000",
      workspaces: [],
      permissions: {},
    })
    expect(info.workspaces).toHaveLength(0)
    expect(info.permissions).toEqual({})
  })

  it("works with multiple workspaces and categories", () => {
    const info = ExternalIdentity.Info.make({
      userId: "99",
      nickName: "multi",
      tenantId: "tenant_01",
      workspaces: [
        { id: "ws_1", name: "知识库A", categories: [{ categoryId: "cat_1", categoryName: "文档", parentId: undefined, sort: 1 }] },
        { id: "ws_2", name: "知识库B", categories: [] },
      ],
      permissions: { ws_1: ["read", "write", "admin"], ws_2: ["read"] },
    })
    expect(info.userId).toBe("99")
    expect(info.workspaces).toHaveLength(2)
    expect(info.workspaces[0].categories).toHaveLength(1)
    expect(info.workspaces[0].categories[0].categoryId).toBe("cat_1")
    expect(info.workspaces[0].categories[0].sort).toBe(1)
    expect(info.permissions["ws_1"]).toEqual(["read", "write", "admin"])
    expect(info.permissions["ws_2"]).toEqual(["read"])
  })

  it("can be used as a Context.Service key", () => {
    const info = ExternalIdentity.Info.make({
      userId: "ctx_test",
      nickName: "context",
      tenantId: "ctx_tenant",
      workspaces: [],
      permissions: {},
    })

    const layer = Layer.succeed(ExternalIdentity, ExternalIdentity.of(info))
    const effect = Effect.gen(function* () {
      const svc = yield* ExternalIdentity
      return svc
    })

    const result = Effect.runSync(Effect.provide(effect, layer))
    expect(result.userId).toBe("ctx_test")
  })
})

describe("ExternalIdentityAdapter", () => {
  it("conforms to the expected interface shape", () => {
    const adapter: ExternalIdentityAdapter = {
      authenticate: (_token: string, _clientId?: string) => {
        return Effect.succeed(
          ExternalIdentity.Info.make({
            userId: "adapter_test",
            nickName: "adapter",
            tenantId: "adapter_tenant",
            workspaces: [],
            permissions: {},
          }),
        )
      },
    }
    // Verify it compiles and the returned shape is correct
    expect(adapter).toHaveProperty("authenticate")
    expect(typeof adapter.authenticate).toBe("function")
  })
})

describe("ExternalIdentityInfo schema", () => {
  it("is exported and can be used standalone", () => {
    const info = ExternalIdentityInfo.make({
      userId: "schema_test",
      nickName: "schema",
      tenantId: "schema_tenant",
      workspaces: [],
      permissions: {},
    })
    expect(info.userId).toBe("schema_test")
  })
})
