/**
 * 会话模式（知识库会话）下的知识入库权限策略。
 *
 * 知识库会话里，agent 按 llm-wiki 技能把素材写进知识库（raw/ + wiki/ + index.md 等）。
 * 该写库行为只允许管理员执行：externalUserId === 管理员 userId（默认 "1"）。
 * 其他外部用户一律拒绝：agent 必须明确回复"无权限"，且不产生任何知识库写入；
 * 只读能力（查询 / 问答 / digest / status / graph / lint）不受影响。
 *
 * **只约束会话模式**：业务系统走 `POST /serve/api/ingest` 的接口入库不受此策略影响；
 * 服务端内部无头会话（wiki / ppt / ingest 管线）没有外部用户身份，同样不受限 ——
 * 否则自动入库会被自己拦死。
 *
 * 本模块只做判定和文案，不落盘、不调服务，便于测试；实际的系统提示词注入见
 * `session/prompt.ts`。
 */

import { Effect } from "effect"

/** 默认管理员 userId（业务系统约定 user_id = 1 为管理员）。 */
export const DEFAULT_ADMIN_USER_ID = "1"

/**
 * 允许**会话模式**入库的管理员 userId 列表。KNOWLEDGE_INGEST_ADMIN_USERIDS 逗号分隔，
 * 读取自进程环境（便于部署与测试）；未配置时默认 "1"。配置为空串 = 没有管理员（fail-closed）。
 */
export function ingestAdminUserIds(): string[] {
  return (process.env.KNOWLEDGE_INGEST_ADMIN_USERIDS ?? DEFAULT_ADMIN_USER_ID)
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

/** 该 userId 是否允许入库。 */
export function isIngestAdmin(userId: string | undefined): boolean {
  return userId !== undefined && ingestAdminUserIds().includes(userId)
}

export type IngestActor =
  /** 管理员：会话入库放行 */
  | "admin"
  /** 其他外部用户：会话入库禁止，agent 需明确回复无权限 */
  | "restricted"
  /** 服务端内部无头会话：不限制 */
  | "internal"

/** 会话 metadata 里的外部用户 id（与外层 Session 隔离字段一致）。 */
export function externalUserIdOf(metadata: Record<string, unknown> | undefined): string | undefined {
  const userId = metadata?.["externalUserId"]
  return typeof userId === "string" && userId.length > 0 ? userId : undefined
}

/**
 * 由会话 metadata 判定入库身份：
 * - 无 / 空 externalUserId → "internal"（内部无头会话，不限制）
 * - externalUserId === 管理员 → "admin"
 * - 其他 → "restricted"
 */
export function resolveIngestActor(metadata: Record<string, unknown> | undefined): IngestActor {
  const userId = externalUserIdOf(metadata)
  if (userId === undefined) return "internal"
  return isIngestAdmin(userId) ? "admin" : "restricted"
}

/** 判断身份的会话最小形状（只用到 metadata 和父会话 id）。 */
export interface IngestSessionNode<ID extends string = string> {
  metadata?: Record<string, unknown>
  parentID?: ID
}

/** 子会话沿 parentID 向上继承属主判定的最大层数。 */
export const MAX_INGEST_POLICY_PARENT_DEPTH = 8

/**
 * 会话模式下的入库策略块：受限用户返回"明确拒绝"文案，管理员/内部会话返回 undefined。
 *
 * 子会话（task 子代理）自身没有 externalUserId，会沿 parentID 向上找到属主会话再判定，
 * 避免用子代理绕过限制；内部无头会话（wiki/ppt/ingest 管线）既无 externalUserId 也无
 * parentID，保持不受限。
 */
export function sessionIngestPolicy<ID extends string>(
  session: IngestSessionNode<ID>,
  loadParent: (id: ID) => Effect.Effect<IngestSessionNode<ID> | undefined>,
): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    let metadata = session.metadata
    let parentID = session.parentID
    let depth = 0
    while (externalUserIdOf(metadata) === undefined && parentID && depth < MAX_INGEST_POLICY_PARENT_DEPTH) {
      const parent = yield* loadParent(parentID)
      if (!parent) break
      metadata = parent.metadata
      parentID = parent.parentID
      depth++
    }
    return ingestPolicyPrompt(resolveIngestActor(metadata), externalUserIdOf(metadata))
  })
}

/** 注入系统提示词的入库策略块；仅受限身份注入，其他身份返回 undefined。 */
export function ingestPolicyPrompt(actor: IngestActor, userId?: string): string | undefined {
  if (actor !== "restricted") return undefined
  const admin = ingestAdminUserIds().join(", ")
  return [
    "<knowledge_ingest_policy>",
    `当前会话用户 userId=${userId ?? "未知"} 不是知识库管理员，禁止执行知识入库。`,
    "禁止的操作包括：",
    "- llm-wiki 的 ingest / batch-ingest / crystallize / delete 工作流；",
    "- 在 raw/、wiki/sources/、wiki/entities/、wiki/topics/、wiki/synthesis/ 下新建或修改文件；",
    "- 修改 index.md、log.md、overview.md、purpose.md、.wiki-cache.json 等知识库文件；",
    "- 执行 init-wiki.sh、cache.sh、create-source-page.sh 等入库脚本。",
    "用户要求入库（如“帮我消化这篇”“把这个记进知识库”“添加素材”“更新知识库”）时，不要执行，" +
      `也不要改用其它工具迂回写入，直接明确回复：无权限：知识入库仅限管理员（userId=${admin}）操作。`,
    "只读能力不受限制：查询、问答、digest、status、graph、lint 等照常提供。",
    "</knowledge_ingest_policy>",
  ].join("\n")
}
