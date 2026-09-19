import { createSignal, type Accessor } from "solid-js"

/** 会话 metadata 里「不查本地知识库」的键，必须与服务端 local-search-policy 一致。 */
export const LOCAL_KNOWLEDGE_KEY = "knowledgeLocalSearch"

/**
 * 只有显式 false 才算关掉本地检索；缺失或非布尔值都保持原行为，
 * 免得别人写坏 metadata 时顺手关掉了知识库。
 */
export function localKnowledgeOff(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[LOCAL_KNOWLEDGE_KEY] === false
}

export type PromptInputLocalKnowledgeInput = {
  sessionID: Accessor<string | undefined>
  metadata: (sessionID: string) => Record<string, unknown> | undefined
  directory: (sessionID: string) => string | undefined
  update: (input: { sessionID: string; directory?: string; off: boolean }) => Promise<void>
  onError: (error: unknown) => void
}

/**
 * 会话输入框下方的「不查本地知识库」开关。
 *
 * 新建会话时还没有 id，metadata 只能等创建后补写，所以开关先记在本地，
 * 由 flush 在创建之后落到会话上；已有会话则直接写 metadata。
 */
export function createPromptInputLocalKnowledge(input: PromptInputLocalKnowledgeInput) {
  const [draftOff, setDraftOff] = createSignal(false)
  let inFlight: Promise<unknown> = Promise.resolve()

  const write = (sessionID: string, directory: string | undefined, off: boolean) => {
    // 写入失败只上报，不让调用方（发送流程）因为开关写不进去而中断
    inFlight = input.update({ sessionID, directory, off }).then(
      () => true,
      (error) => {
        input.onError(error)
        return false
      },
    )
    return inFlight
  }

  const active = () => {
    const id = input.sessionID()
    return id ? localKnowledgeOff(input.metadata(id)) : draftOff()
  }

  const toggle = () => {
    const id = input.sessionID()
    if (!id) {
      setDraftOff((value) => !value)
      return
    }
    void write(id, input.directory(id), !active())
  }

  /**
   * 发送前对齐服务端：先等在途写入落库，再把新建会话上的开关补写一次。
   * 不这么做的话，紧跟着的这条消息仍会在服务端按旧状态去检索知识库。
   */
  const flush = async (sessionID: string, directory: string) => {
    await inFlight
    if (!draftOff()) return
    setDraftOff(false)
    await write(sessionID, directory, true)
  }

  return { active, toggle, flush }
}

export type PromptInputLocalKnowledge = ReturnType<typeof createPromptInputLocalKnowledge>
