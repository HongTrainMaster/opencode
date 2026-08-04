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

export interface KnowledgeGraphStoreShape {
  readonly migrate: Effect.Effect<void>
  readonly replaceDocumentGraph: (args: ReplaceDocumentGraphArgs) => Effect.Effect<ReplaceDocumentResult>
  readonly deleteDocumentGraph: (args: { workspaceId: string; documentId: string }) => Effect.Effect<DeleteDocumentResult>
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

  return {
    migrate: Effect.sync(migrate),

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
