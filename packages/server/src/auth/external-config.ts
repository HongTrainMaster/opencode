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
        return ExternalAuthConfig.of({ apiBaseUrl })
      }),
    )
  }
}
