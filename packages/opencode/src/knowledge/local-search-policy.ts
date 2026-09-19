/**
 * 会话模式下的「不查本地知识库」开关。
 *
 * 会话框上的开关打开时，把 false 写进会话 metadata 的 knowledgeLocalSearch 键；
 * 此后该会话的系统提示词不再自动加载 llm-wiki 技能，模型直接凭自身知识回答。
 *
 * 缺省（键不存在 / 非布尔值）保持现状：照常加载 llm-wiki 并检索知识库。这样既有会话
 * 行为不变，畸形数据也不会让用户莫名丢掉知识库。
 *
 * 本模块只做判定和文案，不落盘、不调服务，便于测试；实际的系统提示词注入见
 * `session/prompt.ts`。
 */

/** 会话 metadata 里承载该开关的键。 */
export const SKIP_LOCAL_KNOWLEDGE_KEY = "knowledgeLocalSearch"

/** 是否跳过本地知识库：只有显式写入 false 才算关闭。 */
export function shouldSkipLocalKnowledge(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[SKIP_LOCAL_KNOWLEDGE_KEY] === false
}

/** 注入系统提示词的开关说明块。 */
export function localSearchDisabledPrompt(): string {
  return [
    "<knowledge_local_search_disabled>",
    "本次会话已关闭本地知识库检索：不要加载也不要使用 llm-wiki 技能，不要检索本地知识库目录。",
    "直接依据自身知识回答用户的问题；确实不确定时如实说明，不要改用其它工具迂回检索知识库。",
    "</knowledge_local_search_disabled>",
  ].join("\n")
}
