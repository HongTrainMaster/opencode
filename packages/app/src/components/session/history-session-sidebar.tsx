import { createQuery } from "@tanstack/solid-query"
import { For, Show, createMemo } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"

const HISTORY_LIMIT = 50

type HistorySession = {
  id: string
  title: string
  directory: string
  archived?: number
}

/**
 * 会话页左侧的历史会话侧栏：列出当前工作目录下的历史会话，
 * 点击打开，支持归档（删除）按钮。顶部标签关闭只从标签栏移除、
 * 不归档会话，因此关闭后的会话仍能在这里重新打开。
 */
export function HistorySessionSidebar(props: { onClose?: () => void }) {
  const sdk = useSDK()
  const server = useServer()
  const tabs = useTabs()
  const language = useLanguage()
  const dialog = useDialog()

  const directory = createMemo(() => sdk().directory)
  const serverKey = createMemo(() => server.key)

  const sessionsQuery = createQuery(() => ({
    queryKey: ["history-sessions", serverKey(), directory()] as const,
    enabled: !!directory(),
    queryFn: async () => {
      const result = await sdk().client.session.list({
        directory: directory(),
        limit: HISTORY_LIMIT,
        roots: true,
      })
      const list = (result as { data?: unknown }).data ?? result
      return Array.isArray(list) ? (list as HistorySession[]) : []
    },
  }))

  const sessions = createMemo(() => (sessionsQuery.data ?? []).filter((s) => !s.archived))

  const openSession = (session: HistorySession) => {
    const tab = tabs.addSessionTab({
      server: serverKey(),
      sessionId: session.id,
    })
    tabs.select(tab)
  }

  const doArchive = (session: HistorySession) => {
    void sdk()
      .client.session.update({
        sessionID: session.id,
        directory: session.directory,
        time: { archived: Date.now() },
      })
      .then(() => {
        notifySessionTabsRemoved({
          server: serverKey(),
          directory: session.directory,
          sessionIDs: [session.id],
        })
        void sessionsQuery.refetch()
      })
      .catch((error) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const confirmArchive = (session: HistorySession) => {
    dialog.show(() => (
      <Dialog
        title={language.t("session.delete.title")}
        description={language.t("session.delete.confirm", { name: session.title || "" })}
        action={
          <div class="flex justify-end gap-2">
            <ButtonV2 variant="neutral" size="normal" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2
              variant="danger"
              size="normal"
              onClick={() => {
                dialog.close()
                doArchive(session)
              }}
            >
              {language.t("session.delete.button")}
            </ButtonV2>
          </div>
        }
      />
    ))
  }

  return (
    <aside
      class="h-full shrink-0 flex flex-col border-r border-border-weaker-base bg-v2-background-bg-base"
      style={{ width: "240px" }}
    >
      <div class="h-10 shrink-0 flex items-center gap-1 px-2">
        <span class="flex-1 min-w-0 text-13-medium text-text-weak truncate">
          {language.t("session.history.title")}
        </span>
        <Show when={props.onClose}>
          <IconButtonV2
            icon={<Icon name="xmark-small" />}
            variant="ghost-muted"
            size="small"
            onClick={props.onClose}
            aria-label={language.t("common.close")}
          />
        </Show>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        <Show
          when={sessionsQuery.isLoading}
          fallback={
            <Show
              when={sessions().length > 0}
              fallback={
                <div class="px-2 py-3 text-12-regular text-text-faint">
                  {language.t("session.history.empty")}
                </div>
              }
            >
              <For each={sessions()}>
                {(session) => (
                  <div
                    class="group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-background-stronger cursor-pointer"
                    onClick={() => openSession(session)}
                  >
                    <div class="flex-1 min-w-0">
                      <div class="text-13-regular text-text truncate">
                        {session.title || language.t("session.history.untitled")}
                      </div>
                    </div>
                    <div class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <TooltipV2 value={language.t("common.delete")} placement="bottom" gutter={6}>
                        <IconButtonV2
                          icon={<Icon name="xmark-small" />}
                          variant="ghost-muted"
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation()
                            confirmArchive(session)
                          }}
                          aria-label={language.t("common.delete")}
                        />
                      </TooltipV2>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          }
        >
          <div class="px-2 py-3 text-12-regular text-text-faint">{language.t("common.loading")}</div>
        </Show>
      </div>
    </aside>
  )
}
