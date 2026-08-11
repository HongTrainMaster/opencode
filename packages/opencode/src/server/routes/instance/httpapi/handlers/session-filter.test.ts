import { describe, expect, it } from "bun:test"
import { DateTime } from "effect"
import { SessionV2, SessionSchema } from "@opencode-ai/core/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { filterSessionsByExternalUser } from "./session"

const now = DateTime.makeUnsafe(Date.now())

function makeSession(id: string, userId?: string, tenantId?: string) {
  return SessionSchema.Info.make({
    id: SessionV2.ID.make(id),
    projectID: ProjectV2.ID.make("prj_test"),
    title: `session-${id}`,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
    location: { directory: AbsolutePath.make("/virtual/test") },
    metadata:
      userId && tenantId
        ? { externalUserId: userId, externalTenantId: tenantId }
        : undefined,
  }) as SessionSchema.Info & { id: string; metadata?: Record<string, unknown> | undefined }
}

describe("filterSessionsByExternalUser", () => {
  it("strictly keeps only the current user's sessions, dropping legacy sessions without metadata", () => {
    const sessions = [
      makeSession("ses_own", "user_1", "tenant_01"),
      makeSession("ses_other", "user_2", "tenant_02"),
      makeSession("ses_legacy"),
    ]
    const filtered = filterSessionsByExternalUser(
      sessions,
      "user_1",
      "tenant_01",
    )
    const ids = filtered.map((s) => (s as { id: string }).id)
    expect(ids).toContain("ses_own")
    expect(ids).not.toContain("ses_other")
    // 严格隔离：无 metadata 的旧会话不返回，避免不同用户互相看到
    expect(ids).not.toContain("ses_legacy")
  })

  it("filters out other users even with same tenant", () => {
    const sessions = [
      makeSession("ses_own", "user_1", "tenant_01"),
      makeSession("ses_sametenant", "user_2", "tenant_01"),
    ]
    const filtered = filterSessionsByExternalUser(
      sessions,
      "user_1",
      "tenant_01",
    )
    expect(filtered.map((s) => (s as { id: string }).id)).toEqual(["ses_own"])
  })

  it("filters out sessions from another tenant even with same user id", () => {
    const sessions = [
      makeSession("ses_own", "user_1", "tenant_01"),
      makeSession("ses_othertenant", "user_1", "tenant_02"),
    ]
    const filtered = filterSessionsByExternalUser(
      sessions,
      "user_1",
      "tenant_01",
    )
    expect(filtered.map((s) => (s as { id: string }).id)).toEqual(["ses_own"])
  })

  it("returns empty when the user owns no sessions and no legacy sessions exist", () => {
    const sessions = [makeSession("ses_other", "user_2", "tenant_02")]
    expect(filterSessionsByExternalUser(sessions, "user_1", "tenant_01")).toEqual([])
  })
})
