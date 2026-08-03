import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { join } from "node:path"
import { z } from "zod/v3"

const dbPath =
  Bun.env.KNOWLEDGE_GRAPH_DB_PATH ??
  join(Bun.env.XDG_DATA_HOME ?? join(process.cwd(), ".opencode"), "knowledge-graph.db")
const db = new Database(dbPath, { create: true })

function listEntities(args: { query?: string; type?: string; limit?: number }) {
  const limit = Math.min(args.limit ?? 50, 100)
  const conditions = ["scope = 'PUBLIC'"]
  const params: any[] = []
  if (args.type) {
    conditions.push("type = ?")
    params.push(args.type)
  }
  if (args.query) {
    conditions.push("name LIKE ?")
    params.push(`%${args.query}%`)
  }
  params.push(limit)
  return db
    .prepare(
      `SELECT id, name, type, source_document_id AS sourceDocumentId
       FROM kg_entity
       WHERE ${conditions.join(" AND ")}
       ORDER BY name LIMIT ?`,
    )
    .all(...params) as Array<Record<string, unknown>>
}

function entityRelations(args: { entity_id: string; hops?: number }) {
  const hops = args.hops ?? 1
  const seen = new Map<string, Record<string, unknown>>()
  const select = (ids: string[]): Array<Record<string, unknown>> => {
    if (ids.length === 0) return []
    const ph = ids.map(() => "?").join(",")
    const bindings: SQLQueryBindings[] = [...ids, ...ids]
    return db
      .prepare(
        `SELECT id, head_entity_id AS head, tail_entity_id AS tail, relation_type AS relation, confidence
         FROM kg_relation
         WHERE (head_entity_id IN (${ph}) OR tail_entity_id IN (${ph}))
           AND scope = 'PUBLIC'`,
      )
      .all(...bindings) as Array<Record<string, unknown>>
  }
  const current: Array<Record<string, unknown>> = select([args.entity_id])
  for (const r of current) seen.set(r.id as string, r)
  if (hops >= 2) {
    const neighbors: string[] = [...new Set(current.flatMap((r) => [r.head, r.tail] as string[]))]
    for (const r of select(neighbors)) seen.set(r.id as string, r)
  }
  return [...seen.values()]
}

const server = new McpServer({
  name: "knowledge-graph-mcp",
  version: "0.0.0",
})

// @ts-expect-error TS2589
server.registerTool(
  "kg_search_entities",
  {
    title: "Search Knowledge Graph Entities",
    description: "Searches the public knowledge graph for entities by name and/or type.",
    inputSchema: {
      query: z.string().optional().describe("Substring to match against entity names"),
      type: z.string().optional().describe("Entity type filter (制度/流程/角色/项目/概念/文档/产品)"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum results (default 50)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const rows = listEntities(args ?? {})
    return { content: [{ type: "text", text: JSON.stringify(rows) }] }
  },
)

// @ts-expect-error TS2589
server.registerTool(
  "kg_entity_relations",
  {
    title: "Knowledge Graph Entity Relations",
    description: "Returns relations (1 or 2 hops) for a given entity id.",
    inputSchema: {
      entity_id: z.string().min(1).describe("Entity id returned by kg_search_entities"),
      hops: z.union([z.literal(1), z.literal(2)]).optional().describe("Number of hops (default 1)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const rows = entityRelations(args)
    return { content: [{ type: "text", text: JSON.stringify(rows) }] }
  },
)

await server.connect(new StdioServerTransport())
