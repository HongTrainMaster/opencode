import path from "path"
import { AbsolutePath } from "./schema"
import { WorkspaceV2 } from "./workspace"

export interface VirtualWorkspaceRef {
  readonly directory: string
  readonly workspaceID: string | undefined
}

export const VirtualWorkspaceResolver = {
  resolve: (identity: { tenantId: string; userId: string }, workspaceId: string): VirtualWorkspaceRef => {
    // Use a virtual path under the OS temp or data dir
    // No real directory is created — just a logical key
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
