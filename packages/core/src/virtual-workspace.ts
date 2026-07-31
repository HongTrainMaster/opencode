import path from "path"
import { AbsolutePath } from "./schema"
import { WorkspaceV2 } from "./workspace"

export interface VirtualWorkspaceRef {
  readonly directory: AbsolutePath
  readonly workspaceID: string | undefined
}

export const VirtualWorkspaceResolver = {
  resolve: (
    identity: { tenantId: string; userId: string },
    workspaceId: string,
    llmPath?: string,
  ): VirtualWorkspaceRef => {
    // When llmPath is provided, it points to the actual knowledge base files on
    // disk. Use it directly so search/file operations within the session can
    // read real content instead of an empty virtual directory.
    if (llmPath) {
      return {
        directory: AbsolutePath.make(llmPath),
        workspaceID: WorkspaceV2.ID.make(`wrk_${identity.tenantId}:${workspaceId}`),
      }
    }
    // Without llmPath, create an isolated workspace directory under the
    // runtime virtual directory for identity-scoped sandboxing.
    const virtualDir = path.join(
      process.env.XDG_DATA_HOME ?? path.join(process.cwd(), ".opencode"),
      "virtual",
      identity.tenantId,
      workspaceId,
    )
    return {
      directory: AbsolutePath.make(virtualDir),
      workspaceID: WorkspaceV2.ID.make(`wrk_${identity.tenantId}:${workspaceId}`),
    }
  },

  sessionMetadataFilter: (identity: { userId: string; tenantId: string }) => ({
    externalTenantId: identity.tenantId,
    externalUserId: identity.userId,
  }),
}
