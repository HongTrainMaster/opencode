import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createPromptInputLocalKnowledge, localKnowledgeOff } from "./local-knowledge"

const noError = (error: unknown) => {
  throw new Error(`unexpected update failure: ${String(error)}`)
}

describe("local knowledge switch", () => {
  test("treats only an explicit false as off", () => {
    expect(localKnowledgeOff(undefined)).toBe(false)
    expect(localKnowledgeOff({})).toBe(false)
    expect(localKnowledgeOff({ knowledgeLocalSearch: true })).toBe(false)
    expect(localKnowledgeOff({ knowledgeLocalSearch: false })).toBe(true)
    expect(localKnowledgeOff({ knowledgeLocalSearch: "false" })).toBe(false)
  })

  test("toggling an existing session writes the flag for that session", async () => {
    const metadata: Record<string, unknown> = { knowledgeLocalSearch: true }
    const calls: { sessionID: string; directory?: string; off: boolean }[] = []
    const knowledge = createPromptInputLocalKnowledge({
      sessionID: () => "ses_1",
      metadata: () => metadata,
      directory: () => "/work",
      update: async (input) => {
        calls.push(input)
        metadata.knowledgeLocalSearch = !input.off
      },
      onError: noError,
    })

    expect(knowledge.active()).toBe(false)
    knowledge.toggle()
    await knowledge.flush("ses_1", "/work")

    expect(calls).toEqual([{ sessionID: "ses_1", directory: "/work", off: true }])
    expect(knowledge.active()).toBe(true)
  })

  test("toggle flips back on the second press", async () => {
    const metadata: Record<string, unknown> = { knowledgeLocalSearch: false }
    const calls: { off: boolean }[] = []
    const knowledge = createPromptInputLocalKnowledge({
      sessionID: () => "ses_1",
      metadata: () => metadata,
      directory: () => "/work",
      update: async (input) => {
        calls.push({ off: input.off })
        metadata.knowledgeLocalSearch = !input.off
      },
      onError: noError,
    })

    expect(knowledge.active()).toBe(true)
    knowledge.toggle()
    await knowledge.flush("ses_1", "/work")

    expect(calls).toEqual([{ off: false }])
    expect(knowledge.active()).toBe(false)
  })

  test("holds the flag locally until the session exists", async () => {
    const calls: { sessionID: string; directory?: string; off: boolean }[] = []
    const knowledge = createPromptInputLocalKnowledge({
      sessionID: () => undefined,
      metadata: () => undefined,
      directory: () => undefined,
      update: async (input) => {
        calls.push(input)
      },
      onError: noError,
    })

    knowledge.toggle()
    expect(knowledge.active()).toBe(true)
    expect(calls).toEqual([])

    await knowledge.flush("ses_new", "/work")
    expect(calls).toEqual([{ sessionID: "ses_new", directory: "/work", off: true }])

    // 补写只发生一次：开关已经落到新会话上，再 flush 不该重复写入
    await knowledge.flush("ses_new", "/work")
    expect(calls).toHaveLength(1)
  })

  test("reports a failed write and leaves the switch alone", async () => {
    const errors: unknown[] = []
    const knowledge = createPromptInputLocalKnowledge({
      sessionID: () => "ses_1",
      metadata: () => ({ knowledgeLocalSearch: true }),
      directory: () => "/work",
      update: async () => {
        throw new Error("nope")
      },
      onError: (error) => errors.push(error),
    })

    knowledge.toggle()
    await knowledge.flush("ses_1", "/work")

    expect(errors).toHaveLength(1)
    expect(knowledge.active()).toBe(false)
  })

  test("reads the flag of the session the composer points at", () => {
    const [sessionID, setSessionID] = createSignal<string | undefined>("ses_1")
    const knowledge = createPromptInputLocalKnowledge({
      sessionID,
      metadata: (id) => (id === "ses_1" ? { knowledgeLocalSearch: false } : { knowledgeLocalSearch: true }),
      directory: () => undefined,
      update: async () => {},
      onError: noError,
    })

    expect(knowledge.active()).toBe(true)
    setSessionID("ses_2")
    expect(knowledge.active()).toBe(false)
  })
})
