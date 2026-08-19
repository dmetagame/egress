import { gateway, type LanguageModel } from "ai";
import { AiSdkRiskAnalyzer } from "../analysis/analyzer.js";

export interface AiRiskAnalyzerEnvironment {
  EGRESS_AI_MODEL?: string;
  EGRESS_AI_MODEL_VERSION?: string;
}

export function createConfiguredAiRiskAnalyzer(
  environment: AiRiskAnalyzerEnvironment = process.env,
  options: {
    model?: LanguageModel;
    provider?: string;
    now?: () => Date;
  } = {},
): AiSdkRiskAnalyzer {
  const modelId = environment.EGRESS_AI_MODEL?.trim();
  if (!options.model && !modelId) {
    throw new Error("EGRESS_AI_MODEL is required for live AI risk inference");
  }

  return new AiSdkRiskAnalyzer(
    options.model ?? gateway(modelId!),
    {
      provider: options.provider ?? "vercel-ai-gateway",
      model: modelId ?? "injected-language-model",
      modelVersion: environment.EGRESS_AI_MODEL_VERSION?.trim() || "provider-reported",
    },
    options.now,
  );
}
