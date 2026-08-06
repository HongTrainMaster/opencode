import { Database } from "bun:sqlite"
import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { join } from "node:path"

export interface GraphEntity {
  id: string
  name: string
  type: string
  sourceDocumentId: string
  scope: "PUBLIC" | "PRIVATE"
  ownerId: string
  workspaceId: string
  status: string
}

export interface GraphRelation {
  id: string
  headEntityId: string
  tailEntityId: string
  relationType: string
  confidence: number
  source: string
  sourceDocumentId: string
  scope: string
  ownerId: string
  workspaceId: string
}

export interface ReplaceDocumentGraphArgs {
  workspaceId: string
  documentId: string
  scope: "PUBLIC" | "PRIVATE"
  ownerId: string
  entities: Array<{ name: string; type: string }>
  relations: Array<{ head: string; tail: string; relation: string }>
}

export interface ReplaceDocumentResult {
  entityCount: number
  relationCount: number
}

export interface DeleteDocumentResult {
  deletedEntities: number
  deletedRelations: number
}

/** 入库任务行（kg_ingest_job）。status: RUNNING | SUCCESS | FAILED | INTERRUPTED */
export interface IngestJobRow {
  id: string
  documentId: string
  workspaceId: string
  operation: "CREATE" | "UPDATE" | "DELETE"
  status: "RUNNING" | "SUCCESS" | "FAILED" | "INTERRUPTED"
  entities: number
  relations: number
  summary: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

/** PPT 生成任务行（ppt_gen_job）。status: RUNNING | SUCCESS | FAILED | INTERRUPTED */
export interface PptJobRow {
  id: string
  taskId: string
  prompt: string
  status: "RUNNING" | "SUCCESS" | "FAILED" | "INTERRUPTED"
  outputPath: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface KnowledgeGraphStoreShape {
  readonly migrate: Effect.Effect<void>
  readonly replaceDocumentGraph: (args: ReplaceDocumentGraphArgs) => Effect.Effect<ReplaceDocumentResult>
  readonly deleteDocumentGraph: (args: { workspaceId: string; documentId: string }) => Effect.Effect<DeleteDocumentResult>
  readonly insertIngestJob: (row: {
    id: string
    documentId: string
    workspaceId: string
    operation: "CREATE" | "UPDATE" | "DELETE"
    status: "RUNNING" | "SUCCESS" | "FAILED" | "INTERRUPTED"
    entities?: number
    relations?: number
    summary?: string | null
    error?: string | null
  }) => Effect.Effect<void>
  readonly updateIngestJob: (args: {
    id: string
    status?: "SUCCESS" | "FAILED"
    entities?: number
    relations?: number
    summary?: string | null
    error?: string | null
  }) => Effect.Effect<void>
  readonly getIngestJob: (id: string) => Effect.Effect<IngestJobRow | undefined>
  readonly listIngestJobs: (ids: string[]) => Effect.Effect<IngestJobRow[]>
  /** 重启兜底：把遗留 RUNNING 记录标记为 INTERRUPTED（幂等）。返回受影响行数 */
  readonly interruptRunningIngestJobs: () => Effect.Effect<number>
  readonly insertPptJob: (row: {
    id: string
    taskId: string
    prompt: string
    status: "RUNNING"
  }) => Effect.Effect<void>
  readonly updatePptJob: (args: {
    id: string
    status?: "SUCCESS" | "FAILED"
    outputPath?: string | null
    error?: string | null
  }) => Effect.Effect<void>
  readonly getPptJob: (id: string) => Effect.Effect<PptJobRow | undefined>
  readonly listPptJobs: (ids: string[]) => Effect.Effect<PptJobRow[]>
  readonly interruptRunningPptJobs: () => Effect.Effect<number>
  readonly listEntitiesByDocument: (args: { documentId: string; userId: string }) => Effect.Effect<GraphEntity[]>
  readonly listEntitiesByWorkspace: (args: { workspaceId: string; userId: string }) => Effect.Effect<GraphEntity[]>
  readonly listRelationsByWorkspace: (args: { workspaceId: string; userId: string }) => Effect.Effect<GraphRelation[]>
  readonly getEntity: (args: { entityId: string; userId: string }) => Effect.Effect<GraphEntity | undefined>
  readonly listRelationsForEntity: (args: {
    entityId: string
    userId: string
    hops?: 1 | 2
  }) => Effect.Effect<GraphRelation[]>
}

export class KnowledgeGraphStore extends Context.Service<
  KnowledgeGraphStore,
  KnowledgeGraphStoreShape
>()("@opencode/knowledge/GraphStore") {
  static layer = Layer.effect(
    KnowledgeGraphStore,
    Effect.gen(function* () {
      const filename = yield* EffectConfig.string("KNOWLEDGE_GRAPH_DB_PATH").pipe(
        EffectConfig.withDefault(
          join(process.env.XDG_DATA_HOME ?? join(process.cwd(), ".opencode"), "knowledge-graph.db"),
        ),
      )
      return KnowledgeGraphStore.of(makeStore(filename))
    }),
  )

  static test = (filename: string = ":memory:") =>
    Layer.succeed(KnowledgeGraphStore, KnowledgeGraphStore.of(makeStore(filename)))
}

// --- deterministic ids (idempotency) ---

export function entityId(workspaceId: string, documentId: string, type: string, name: string): string {
  return createHash("sha1").update(`${workspaceId}:${documentId}:${type}:${name}`).digest("hex")
}

export function relationId(headId: string, tailId: string, relationType: string): string {
  return createHash("sha1").update(`${headId}:${tailId}:${relationType}`).digest("hex")
}

// --- implementation ---

function makeStore(filename: string): KnowledgeGraphStoreShape {
  const db = new Database(filename, { create: true })
  if (filename !== ":memory:") db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")

  const migrate = (): void => {
    db.run(`
      CREATE TABLE IF NOT EXISTS kg_entity (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        source_document_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    db.run("CREATE INDEX IF NOT EXISTS idx_kg_entity_doc ON kg_entity(source_document_id)")
    db.run("CREATE INDEX IF NOT EXISTS idx_kg_entity_scope_owner ON kg_entity(scope, owner_id)")
    db.run(`
      CREATE TABLE IF NOT EXISTS kg_relation (
        id TEXT PRIMARY KEY,
        head_entity_id TEXT NOT NULL,
        tail_entity_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source TEXT NOT NULL DEFAULT 'llm',
        source_document_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(head_entity_id, tail_entity_id, relation_type)
      )
    `)
    db.run("CREATE INDEX IF NOT EXISTS idx_kg_relation_head ON kg_relation(head_entity_id)")
    db.run("CREATE INDEX IF NOT EXISTS idx_kg_relation_tail ON kg_relation(tail_entity_id)")
    db.run("CREATE INDEX IF NOT EXISTS idx_kg_relation_doc ON kg_relation(source_document_id)")
    db.run(`
      CREATE TABLE IF NOT EXISTS kg_ingest_job (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        entities INTEGER NOT NULL DEFAULT 0,
        relations INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    db.run("CREATE INDEX IF NOT EXISTS idx_kg_ingest_job_status ON kg_ingest_job(status)")
    db.run(`
      CREATE TABLE IF NOT EXISTS ppt_gen_job (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        output_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    db.run("CREATE INDEX IF NOT EXISTS idx_ppt_gen_job_status ON ppt_gen_job(status)")
  }
  migrate()

  const now = () => new Date().toISOString()

  const rowToEntity = (row: any): GraphEntity => ({
    id: row.id,
    name: row.name,
    type: row.type,
    sourceDocumentId: row.source_document_id,
    scope: row.scope,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    status: row.status,
  })

  const rowToRelation = (row: any): GraphRelation => ({
    id: row.id,
    headEntityId: row.head_entity_id,
    tailEntityId: row.tail_entity_id,
    relationType: row.relation_type,
    confidence: row.confidence,
    source: row.source,
    sourceDocumentId: row.source_document_id,
    scope: row.scope,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
  })

  const rowToIngestJob = (row: any): IngestJobRow => ({
    id: row.id,
    documentId: row.document_id,
    workspaceId: row.workspace_id,
    operation: row.operation,
    status: row.status,
    entities: row.entities,
    relations: row.relations,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const rowToPptJob = (row: any): PptJobRow => ({
    id: row.id,
    taskId: row.task_id,
    prompt: row.prompt,
    status: row.status,
    outputPath: row.output_path,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  return {
    migrate: Effect.sync(migrate),

    insertIngestJob: (row) =>
      Effect.sync(() => {
        db.prepare(
          `INSERT INTO kg_ingest_job
            (id, document_id, workspace_id, operation, status, entities, relations, summary, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.documentId,
          row.workspaceId,
          row.operation,
          row.status,
          row.entities ?? 0,
          row.relations ?? 0,
          row.summary ?? null,
          row.error ?? null,
          now(),
          now(),
        )
      }),

    updateIngestJob: (args) =>
      Effect.sync(() => {
        db.prepare(
          `UPDATE kg_ingest_job
           SET status = ?, entities = ?, relations = ?, summary = ?, error = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          args.status ?? "FAILED",
          args.entities ?? 0,
          args.relations ?? 0,
          args.summary ?? null,
          args.error ?? null,
          now(),
          args.id,
        )
      }),

    getIngestJob: (id) =>
      Effect.sync(() => {
        const row = db.prepare("SELECT * FROM kg_ingest_job WHERE id = ?").get(id) as any | undefined
        return row ? rowToIngestJob(row) : undefined
      }),

    listIngestJobs: (ids) =>
      Effect.sync(() => {
        if (ids.length === 0) return []
        const ph = ids.map(() => "?").join(",")
        const rows = db
          .prepare(`SELECT * FROM kg_ingest_job WHERE id IN (${ph})`)
          .all(...ids) as Array<any>
        // 按传入顺序返回（SQLite IN 不保序）
        const byId = new Map(rows.map((r) => [r.id, rowToIngestJob(r)]))
        return ids.map((id) => byId.get(id)).filter((r): r is IngestJobRow => r !== undefined)
      }),

    interruptRunningIngestJobs: () =>
      Effect.sync(() => {
        const ts = now()
        const r = db
          .prepare(
            "UPDATE kg_ingest_job SET status = 'INTERRUPTED', updated_at = ? WHERE status = 'RUNNING'",
          )
          .run(ts)
        return r.changes
      }),

    insertPptJob: (row) =>
      Effect.sync(() => {
        db.prepare(
          `INSERT INTO ppt_gen_job
            (id, task_id, prompt, status, output_path, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.taskId,
          row.prompt,
          row.status,
          null,
          null,
          now(),
          now(),
        )
      }),

    updatePptJob: (args) =>
      Effect.sync(() => {
        db.prepare(
          `UPDATE ppt_gen_job
           SET status = ?, output_path = ?, error = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          args.status ?? "FAILED",
          args.outputPath ?? null,
          args.error ?? null,
          now(),
          args.id,
        )
      }),

    getPptJob: (id) =>
      Effect.sync(() => {
        const row = db.prepare("SELECT * FROM ppt_gen_job WHERE id = ?").get(id) as any | undefined
        return row ? rowToPptJob(row) : undefined
      }),

    listPptJobs: (ids) =>
      Effect.sync(() => {
        if (ids.length === 0) return []
        const ph = ids.map(() => "?").join(",")
        const rows = db
          .prepare(`SELECT * FROM ppt_gen_job WHERE id IN (${ph})`)
          .all(...ids) as Array<any>
        const byId = new Map(rows.map((r) => [r.id, rowToPptJob(r)]))
        return ids.map((id) => byId.get(id)).filter((r): r is PptJobRow => r !== undefined)
      }),

    interruptRunningPptJobs: () =>
      Effect.sync(() => {
        const ts = now()
        const r = db
          .prepare(
            "UPDATE ppt_gen_job SET status = 'INTERRUPTED', updated_at = ? WHERE status = 'RUNNING'",
          )
          .run(ts)
        return r.changes
      }),

    replaceDocumentGraph: (args: ReplaceDocumentGraphArgs) =>
      Effect.sync(() => {
        const ts = now()
        const tx = db.transaction(() => {
          db.prepare("DELETE FROM kg_relation WHERE source_document_id = ? AND workspace_id = ?").run(
            args.documentId,
            args.workspaceId,
          )
          db.prepare("DELETE FROM kg_entity WHERE source_document_id = ? AND workspace_id = ?").run(
            args.documentId,
            args.workspaceId,
          )
          const insEnt = db.prepare(`
            INSERT OR REPLACE INTO kg_entity
              (id, name, type, source_document_id, scope, owner_id, workspace_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
          `)
          for (const e of args.entities) {
            insEnt.run(
              entityId(args.workspaceId, args.documentId, e.type, e.name),
              e.name,
              e.type,
              args.documentId,
              args.scope,
              args.ownerId,
              args.workspaceId,
              ts,
              ts,
            )
          }
          const nameToId = new Map(
            args.entities.map((e) => [e.name, entityId(args.workspaceId, args.documentId, e.type, e.name)]),
          )
          const insRel = db.prepare(`
            INSERT OR REPLACE INTO kg_relation
              (id, head_entity_id, tail_entity_id, relation_type, confidence, source, source_document_id, scope, owner_id, workspace_id, created_at)
            VALUES (?, ?, ?, ?, 0.9, 'llm', ?, ?, ?, ?, ?)
          `)
          let insertedRelations = 0
          for (const r of args.relations) {
            const head = nameToId.get(r.head)
            const tail = nameToId.get(r.tail)
            if (!head || !tail) continue
            insRel.run(
              relationId(head, tail, r.relation),
              head,
              tail,
              r.relation,
              args.documentId,
              args.scope,
              args.ownerId,
              args.workspaceId,
              ts,
            )
            insertedRelations++
          }
          return { entityCount: args.entities.length, relationCount: insertedRelations }
        })
        return tx()
      }),

    deleteDocumentGraph: (args: { workspaceId: string; documentId: string }) =>
      Effect.sync(() => {
        const tx = db.transaction(() => {
          const entityRows = db
            .prepare("SELECT id FROM kg_entity WHERE source_document_id = ? AND workspace_id = ?")
            .all(args.documentId, args.workspaceId) as Array<{ id: string }>
          const ids = entityRows.map((r) => r.id)
          let deletedRelations = 0
          if (ids.length > 0) {
            const ph = ids.map(() => "?").join(",")
            deletedRelations = db
              .prepare(
                `DELETE FROM kg_relation WHERE (head_entity_id IN (${ph}) OR tail_entity_id IN (${ph}))`,
              )
              .run(...ids, ...ids).changes
          }
          const deletedEntities = db
            .prepare("DELETE FROM kg_entity WHERE source_document_id = ? AND workspace_id = ?")
            .run(args.documentId, args.workspaceId).changes
          return { deletedEntities, deletedRelations }
        })
        return tx()
      }),

    listEntitiesByDocument: (args: { documentId: string; userId: string }) =>
      Effect.sync(() => {
        const rows = db
          .prepare(
            `SELECT * FROM kg_entity
             WHERE source_document_id = ? AND (scope = 'PUBLIC' OR (scope = 'PRIVATE' AND owner_id = ?))
             ORDER BY name`,
          )
          .all(args.documentId, args.userId) as Array<any>
        return rows.map(rowToEntity)
      }),

    listEntitiesByWorkspace: (args: { workspaceId: string; userId: string }) =>
      Effect.sync(() => {
        const rows = db
          .prepare(
            `SELECT * FROM kg_entity
             WHERE workspace_id = ? AND (scope = 'PUBLIC' OR (scope = 'PRIVATE' AND owner_id = ?))
             ORDER BY name`,
          )
          .all(args.workspaceId, args.userId) as Array<any>
        return rows.map(rowToEntity)
      }),

    listRelationsByWorkspace: (args: { workspaceId: string; userId: string }) =>
      Effect.sync(() => {
        const rows = db
          .prepare(
            `SELECT * FROM kg_relation
             WHERE workspace_id = ? AND (scope = 'PUBLIC' OR (scope = 'PRIVATE' AND owner_id = ?))`,
          )
          .all(args.workspaceId, args.userId) as Array<any>
        return rows.map(rowToRelation)
      }),

    getEntity: (args: { entityId: string; userId: string }) =>
      Effect.sync(() => {
        const row = db
          .prepare(
            `SELECT * FROM kg_entity
             WHERE id = ? AND (scope = 'PUBLIC' OR (scope = 'PRIVATE' AND owner_id = ?))`,
          )
          .get(args.entityId, args.userId) as any | undefined
        return row ? rowToEntity(row) : undefined
      }),

    listRelationsForEntity: (args: { entityId: string; userId: string; hops?: 1 | 2 }) =>
      Effect.sync(() => {
        const hops = args.hops ?? 1
        const seen = new Map<string, GraphRelation>()
        const select = (ids: string[]): GraphRelation[] => {
          if (ids.length === 0) return []
          const ph = ids.map(() => "?").join(",")
          const rows = db
            .prepare(
              `SELECT * FROM kg_relation
               WHERE (head_entity_id IN (${ph}) OR tail_entity_id IN (${ph}))
                 AND (scope = 'PUBLIC' OR (scope = 'PRIVATE' AND owner_id = ?))`,
            )
            .all(...ids, ...ids, args.userId) as Array<any>
          return rows.map(rowToRelation)
        }
        const current = select([args.entityId])
        for (const r of current) seen.set(r.id, r)
        if (hops >= 2) {
          const neighbors = [...new Set(current.flatMap((r) => [r.headEntityId, r.tailEntityId]))]
          for (const r of select(neighbors)) seen.set(r.id, r)
        }
        return [...seen.values()]
      }),
  }
}
