import { describe, expect, it } from "bun:test"
import { VirtualWorkspaceResolver } from "./virtual-workspace"

describe("VirtualWorkspaceResolver", () => {
  it("resolves workspace to a virtual directory path", () => {
    const result = VirtualWorkspaceResolver.resolve({
      userId: "42",
      tenantId: "000000",
      workspaces: [],
      permissions: {},
    }, "kb_001")
    expect(result.directory).toContain("virtual")
    expect(result.directory).toContain("000000")
    expect(result.directory).toContain("kb_001")
  })
})
