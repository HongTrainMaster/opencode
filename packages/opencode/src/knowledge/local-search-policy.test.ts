import { describe, expect, it } from "bun:test"
import { SKIP_LOCAL_KNOWLEDGE_KEY, localSearchDisabledPrompt, shouldSkipLocalKnowledge } from "./local-search-policy"

describe("shouldSkipLocalKnowledge", () => {
  it("keeps searching when the switch was never touched", () => {
    expect(shouldSkipLocalKnowledge(undefined)).toBe(false)
    expect(shouldSkipLocalKnowledge({})).toBe(false)
    expect(shouldSkipLocalKnowledge({ externalUserId: "1" })).toBe(false)
  })

  it("keeps searching when the switch is explicitly on", () => {
    expect(shouldSkipLocalKnowledge({ knowledgeLocalSearch: true })).toBe(false)
  })

  it("skips the knowledge base only when the switch is explicitly off", () => {
    expect(shouldSkipLocalKnowledge({ knowledgeLocalSearch: false })).toBe(true)
    expect(shouldSkipLocalKnowledge({ knowledgeLocalSearch: false, externalUserId: "1" })).toBe(true)
  })

  it("ignores non-boolean values so a malformed session never silently loses the knowledge base", () => {
    expect(shouldSkipLocalKnowledge({ knowledgeLocalSearch: "false" })).toBe(false)
    expect(shouldSkipLocalKnowledge({ knowledgeLocalSearch: 0 })).toBe(false)
    expect(shouldSkipLocalKnowledge({ knowledgeLocalSearch: null })).toBe(false)
  })

  it("reads the documented metadata key", () => {
    expect(SKIP_LOCAL_KNOWLEDGE_KEY).toBe("knowledgeLocalSearch")
  })
})

describe("localSearchDisabledPrompt", () => {
  it("tells the agent not to load llm-wiki and to answer from its own knowledge", () => {
    const prompt = localSearchDisabledPrompt()
    expect(prompt.startsWith("<knowledge_local_search_disabled>")).toBe(true)
    expect(prompt.endsWith("</knowledge_local_search_disabled>")).toBe(true)
    expect(prompt).toContain("llm-wiki")
    expect(prompt).toContain("不要检索本地知识库")
  })
})
