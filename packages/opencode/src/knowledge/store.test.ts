import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { KnowledgeGraphStore } from "./store"

const run = <A>(effect: Effect.Effect<A, never, KnowledgeGraphStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(KnowledgeGraphStore.test(":memory:"))))

function entityIdOf(workspaceId: string, documentId: string, type: string, name: string): string {
  return createHash("sha1").update(`${workspaceId}:${documentId}:${type}:${name}`).digest("hex")
}

describe("KnowledgeGraphStore", () => {
  it("replaces document graph and lists entities by document", async () => {
    const entities = await run(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        const result = yield* store.replaceDocumentGraph({
          workspaceId: "kb_1",
          documentId: "10001",
          scope: "PUBLIC",
          ownerId: "",
          entities: [
            { name: "考勤制度", type: "制度" },
            { name: "人力资源部", type: "角色" },
          ],
          relations: [{ head: "考勤制度", tail: "人力资源部", relation: "负责" }],
        })
        expect(result.entityCount).toBe(2)
        expect(result.relationCount).toBe(1)
        return yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
      }),
    )
    expect(entities).toHaveLength(2)
    expect(entities.map((e) => e.name).sort()).toEqual(["人力资源部", "考勤制度"])
  })

  it("isolates PRIVATE graph by owner", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        yield* store.replaceDocumentGraph({
          workspaceId: "my_user_1",
          documentId: "20001",
          scope: "PRIVATE",
          ownerId: "user_1",
          entities: [{ name: "私人笔记", type: "文档" }],
          relations: [],
        })
        const own = yield* store.listEntitiesByDocument({ documentId: "20001", userId: "user_1" })
        expect(own).toHaveLength(1)
        const other = yield* store.listEntitiesByDocument({ documentId: "20001", userId: "user_2" })
        expect(other).toHaveLength(0)
        const entity = yield* store.getEntity({
          entityId: entityIdOf("my_user_1", "20001", "文档", "私人笔记"),
          userId: "user_2",
        })
        expect(entity).toBeUndefined()
      }),
    )
  })

  it("is idempotent: re-ingest overwrites old graph data", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        yield* store.replaceDocumentGraph({
          workspaceId: "kb_1",
          documentId: "10001",
          scope: "PUBLIC",
          ownerId: "",
          entities: [{ name: "旧制度", type: "制度" }],
          relations: [],
        })
        yield* store.replaceDocumentGraph({
          workspaceId: "kb_1",
          documentId: "10001",
          scope: "PUBLIC",
          ownerId: "",
          entities: [{ name: "新制度", type: "制度" }],
          relations: [],
        })
        return yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
      }),
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("新制度")
  })

  it("deletes document graph including relations", async () => {
    const deleted = await run(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        yield* store.replaceDocumentGraph({
          workspaceId: "kb_1",
          documentId: "10001",
          scope: "PUBLIC",
          ownerId: "",
          entities: [
            { name: "考勤制度", type: "制度" },
            { name: "人力资源部", type: "角色" },
          ],
          relations: [{ head: "考勤制度", tail: "人力资源部", relation: "负责" }],
        })
        const res = yield* store.deleteDocumentGraph({ workspaceId: "kb_1", documentId: "10001" })
        const remaining = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        return { res, remaining }
      }),
    )
    expect(deleted.res.deletedEntities).toBe(2)
    expect(deleted.res.deletedRelations).toBe(1)
    expect(deleted.remaining).toHaveLength(0)
  })

  it("lists 2-hop relations for an entity", async () => {
    const rels = await run(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        yield* store.replaceDocumentGraph({
          workspaceId: "kb_1",
          documentId: "10001",
          scope: "PUBLIC",
          ownerId: "",
          entities: [
            { name: "A", type: "概念" },
            { name: "B", type: "概念" },
            { name: "C", type: "概念" },
          ],
          relations: [
            { head: "A", tail: "B", relation: "包含" },
            { head: "B", tail: "C", relation: "引用" },
          ],
        })
        const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        const a = entities.find((e) => e.name === "A")!
        return yield* store.listRelationsForEntity({ entityId: a.id, userId: "user_1", hops: 2 })
      }),
    )
    expect(rels.map((r) => r.relationType).sort()).toEqual(["包含", "引用"])
  })

  it("lists all entities in a workspace (excludes other workspaces)", async () => {
    const entities = await run(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        yield* store.replaceDocumentGraph({
          workspaceId: "kb_1",
          documentId: "10001",
          scope: "PUBLIC",
          ownerId: "",
          entities: [
            { name: "考勤制度", type: "制度" },
            { name: "人力资源部", type: "角色" },
          ],
          relations: [{ head: "考勤制度", tail: "人力资源部", relation: "负责" }],
        })
        yield* store.replaceDocumentGraph({
          workspaceId: "kb_2",
          documentId: "20001",
          scope: "PUBLIC",
          ownerId: "",
          entities: [{ name: "他库实体", type: "概念" }],
          relations: [],
        })
        return yield* store.listEntitiesByWorkspace({ workspaceId: "kb_1", userId: "user_1" })
      }),
    )
    expect(entities).toHaveLength(2)
    expect(entities.map((e) => e.name).sort()).toEqual(["人力资源部", "考勤制度"])
  })

  it("lists all relations in a workspace (cross-document edges included)", async () => {
    const relations = await run(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        yield* store.replaceDocumentGraph({
          workspaceId: "kb_1",
          documentId: "10001",
          scope: "PUBLIC",
          ownerId: "",
          entities: [
            { name: "考勤制度", type: "制度" },
            { name: "人力资源部", type: "角色" },
          ],
          relations: [{ head: "考勤制度", tail: "人力资源部", relation: "负责" }],
        })
        yield* store.replaceDocumentGraph({
          workspaceId: "kb_1",
          documentId: "10002",
          scope: "PUBLIC",
          ownerId: "",
          entities: [
            { name: "考勤制度", type: "制度" },
            { name: "请假流程", type: "流程" },
          ],
          relations: [{ head: "考勤制度", tail: "请假流程", relation: "包含" }],
        })
        return yield* store.listRelationsByWorkspace({ workspaceId: "kb_1", userId: "user_1" })
      }),
    )
    expect(relations).toHaveLength(2)
  })

  it("isolates PRIVATE workspace relations by owner", async () => {
    const relations = await run(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        yield* store.replaceDocumentGraph({
          workspaceId: "my_user_1",
          documentId: "20001",
          scope: "PRIVATE",
          ownerId: "user_1",
          entities: [{ name: "私人笔记", type: "文档" }],
          relations: [],
        })
        const own = yield* store.listEntitiesByWorkspace({ workspaceId: "my_user_1", userId: "user_1" })
        expect(own).toHaveLength(1)
        const other = yield* store.listEntitiesByWorkspace({ workspaceId: "my_user_1", userId: "user_2" })
        expect(other).toHaveLength(0)
        return yield* store.listRelationsByWorkspace({ workspaceId: "my_user_1", userId: "user_1" })
      }),
    )
    expect(relations).toHaveLength(0)
  })

  it("inserts, gets, lists and interrupts ppt jobs", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        yield* store.insertPptJob({ id: "job_ppt1", taskId: "ppt_1", prompt: "做公司介绍", status: "RUNNING" })
        const job = yield* store.getPptJob("job_ppt1")
        expect(job?.taskId).toBe("ppt_1")
        expect(job?.status).toBe("RUNNING")
        yield* store.updatePptJob({ id: "job_ppt1", status: "SUCCESS", outputPath: "/tmp/o.pptx" })
        const done = yield* store.getPptJob("job_ppt1")
        expect(done?.status).toBe("SUCCESS")
        expect(done?.outputPath).toBe("/tmp/o.pptx")
        const list = yield* store.listPptJobs(["job_ppt1", "job_ppt_unknown"])
        expect(list).toHaveLength(1)
        yield* store.insertPptJob({ id: "job_ppt2", taskId: "ppt_2", prompt: "x", status: "RUNNING" })
        const interrupted = yield* store.interruptRunningPptJobs()
        expect(interrupted).toBe(1)
        return true
      }),
    )
    expect(result).toBe(true)
  })
})
