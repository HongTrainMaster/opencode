import { Config as EffectConfig, Context, Effect, Layer } from "effect"

export interface ExternalAuthConfigInfo {
  readonly apiBaseUrl: string
}

export class ExternalAuthConfig extends Context.Service<
  ExternalAuthConfig,
  ExternalAuthConfigInfo
>()("@opencode/ExternalAuthConfig") {
  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const apiBaseUrl = yield* EffectConfig.string("KNOWLEDGE_API_BASE_URL")
          .pipe(EffectConfig.withDefault("/api"))
        // 部署护栏：配置了业务 API 但没开会话隔离时给出醒目告警。
        if (process.env.KNOWLEDGE_API_BASE_URL && !isKnowledgeMode()) {
          yield* Effect.logWarning(
            "KNOWLEDGE_API_BASE_URL is set but session isolation is NOT enabled — set " +
              "KNOWLEDGE_SESSION_ISOLATION=true (and KNOWLEDGE_JWT_SECRET) in the knowledge " +
              "deployment, otherwise users can see each other's sessions.",
          )
        }
        return ExternalAuthConfig.of({ apiBaseUrl })
      }),
    )
  }
}

/**
 * Whether this server enforces per-user session isolation ("knowledge mode").
 *
 * Deliberately an explicit opt-in (KNOWLEDGE_SESSION_ISOLATION=true) read live
 * from process.env, so plain opencode deployments are never affected and tests
 * can toggle it per-test. The knowledge deployment MUST set this flag (see
 * deployment docs); the ExternalAuthConfig layer logs a warning when
 * KNOWLEDGE_API_BASE_URL is set without it.
 */
export function isKnowledgeMode(): boolean {
  return process.env.KNOWLEDGE_SESSION_ISOLATION === "true"
}
