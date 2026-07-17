import { createResource, createSignal, For, Show } from "solid-js"

const userInfo = () => (window as any).__USER_INFO__ ?? { workspaces: [], nickName: "" }

export function KnowledgeHome() {
  const [selectedWorkspace, setSelectedWorkspace] = createSignal<string | null>(null)
  const authToken = () => encodeURIComponent((window as any).__INITIAL_AUTH_TOKEN__ ?? "")
  const apiBase = () => {
    const params = new URLSearchParams(location.search)
    const authParam = params.get("auth_token")
    return authParam ? `/knowledge/api` : "/knowledge/api"
  }

  const [sessions] = createResource(
    selectedWorkspace,
    async (wsId: string) => {
      const res = await fetch(`${apiBase()}/sessions?workspaceId=${wsId}&limit=50`)
      const data = await res.json()
      return data.data ?? []
    },
  )

  return (
    <div class="knowledge-home">
      <style>{`
        .knowledge-home { display: flex; height: 100vh; font-family: system-ui, sans-serif; }
        .knowledge-sidebar { width: 260px; background: #f5f5f5; border-right: 1px solid #e0e0e0; padding: 16px; overflow-y: auto; }
        .knowledge-sidebar h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: #333; }
        .knowledge-workspace { display: block; width: 100%; text-align: left; padding: 10px 12px; margin-bottom: 4px; border: none; border-radius: 6px; background: transparent; cursor: pointer; font-size: 13px; transition: background 0.15s; }
        .knowledge-workspace:hover { background: #e8e8e8; }
        .knowledge-workspace.active { background: #d0d0ff; font-weight: 500; }
        .knowledge-main { flex: 1; padding: 24px; overflow-y: auto; }
        .knowledge-session-list { max-width: 640px; }
        .knowledge-session-item { display: block; padding: 14px 16px; border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 8px; text-decoration: none; color: inherit; transition: border-color 0.15s; }
        .knowledge-session-item:hover { border-color: #8888ff; }
        .knowledge-session-item h3 { font-size: 15px; font-weight: 500; margin: 0 0 4px; }
        .knowledge-session-item time { font-size: 12px; color: #888; }
        .knowledge-empty { color: #888; font-size: 14px; padding: 24px; text-align: center; }
        .knowledge-header { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
      `}</style>

      <nav class="knowledge-sidebar">
        <h2>知识库</h2>
        <For each={userInfo().workspaces}>
          {(ws: any) => (
            <button
              classList={{ "knowledge-workspace": true, active: selectedWorkspace() === ws.id }}
              onClick={() => setSelectedWorkspace(ws.id)}
            >
              {ws.name}
            </button>
          )}
        </For>
      </nav>

      <main class="knowledge-main">
        <Show when={!selectedWorkspace()}>
          <div class="knowledge-empty">请选择一个知识库</div>
        </Show>
        <Show when={selectedWorkspace()}>
          <div class="knowledge-header">历史会话</div>
          <div class="knowledge-session-list">
            <Show when={sessions.loading}>
              <div class="knowledge-empty">加载中...</div>
            </Show>
            <Show when={sessions.error}>
              <div class="knowledge-empty">加载失败，请刷新重试</div>
            </Show>
            <Show when={sessions()?.length === 0}>
              <div class="knowledge-empty">暂无会话，返回知识库开始新对话</div>
            </Show>
            <For each={sessions()}>
              {(session: any) => (
                <a
                  class="knowledge-session-item"
                  href={`/knowledge/session/${session.id}?auth_token=${authToken()}`}
                >
                  <h3>{session.title ?? "新会话"}</h3>
                  <Show when={session.time?.created}>
                    <time>{new Date(session.time.created).toLocaleString()}</time>
                  </Show>
                </a>
              )}
            </For>
          </div>
        </Show>
      </main>
    </div>
  )
}
