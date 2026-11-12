import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { providerRepository } from "../repositories/provider.repository.js";
import { config } from "../config.js";
import type { ProviderConfig } from "../types.js";

/** Merge provider headers and optional gateway trace headers; auth wins last. */
function providerRequestHeaders(
  customHeaders: Record<string, string> | undefined,
  apiKey: string | undefined,
): Record<string, string> {
  const headers = { ...customHeaders };
  if (config.llmTraceIdentifier) {
    headers["x-trace-identifier"] = config.llmTraceIdentifier;
  }
  if (config.llmTraceIdentifierType) {
    headers["x-trace-identifier-type"] = config.llmTraceIdentifierType;
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

class ModelService {
  private _modelRuntime: ModelRuntime | null = null;

  get modelRuntime(): ModelRuntime {
    if (!this._modelRuntime) throw new Error("ModelService not initialized");
    return this._modelRuntime;
  }

  async init(agentDir: string): Promise<void> {
    this._modelRuntime = await ModelRuntime.create({
      authPath: resolve(agentDir, "auth.json"),
      modelsPath: resolve(agentDir, "models.json"),
    });

    const providers = await providerRepository.list();
    for (const provider of providers) {
      await this.registerWithSdk(provider);
    }
  }

  async getAvailableModels() {
    return this.modelRuntime.getAvailable();
  }

  getAllModels() {
    return this.modelRuntime.getModels();
  }

  async registerProvider(provider: ProviderConfig): Promise<void> {
    const stored = await providerRepository.createOrUpdate(provider);
    await this.registerWithSdk(stored);
  }

  async unregisterProvider(name: string): Promise<void> {
    this.modelRuntime.unregisterProvider(name);
    await providerRepository.deleteByName(name);
  }

  async listProviders(): Promise<ProviderConfig[]> {
    return providerRepository.list();
  }

  async setRuntimeApiKey(provider: string, apiKey: string): Promise<void> {
    await this.modelRuntime.setRuntimeApiKey(provider, apiKey);
  }

  /**
   * Resolve a request model. MySQL provider config wins; the PROVIDER_* env
   * values only fill a missing API key.
   */
  async resolveModel(provider: string, modelId: string): Promise<any | undefined> {
    const stored = await providerRepository.findByName(provider);
    if (!stored) {
      return this.modelRuntime.getModel(provider, modelId);
    }

    const envKey =
      (config.providerName || config.defaultProvider) === provider
        ? config.providerApiKey
        : "";
    const apiKey = stored.apiKey || envKey || undefined;

    await this.registerWithSdk(stored, apiKey);
    const found = this.modelRuntime.getModel(provider, modelId);
    if (found) return found;

    const fallbackContextWindow = stored.models[0]?.contextWindow ?? 128000;
    const fallbackMaxTokens = stored.models[0]?.maxTokens ?? 4096;
    return {
      id: modelId,
      name: modelId,
      provider,
      api: "openai-completions",
      baseUrl: stored.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: fallbackContextWindow,
      maxTokens: fallbackMaxTokens,
      compat: {
        supportsUsageInStreaming: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
    };
  }

  /**
   * Apply the PROVIDER_* environment fallback when MySQL has no provider with
   * the same name. Returns how the provider was resolved.
   */
  async applyEnvFallback(): Promise<"mysql" | "env" | "none"> {
    if (!config.providerApiKey || !config.providerBaseUrl) return "none";
    const providerName = config.providerName || config.defaultProvider;

    const existing = await providerRepository.findByName(providerName);
    if (existing) {
      if (!existing.apiKey) {
        await this.setRuntimeApiKey(providerName, config.providerApiKey);
      }
      return "mysql";
    }

    await this.registerProvider({
      name: providerName,
      baseUrl: config.providerBaseUrl,
      apiKey: config.providerApiKey,
      models: [
        {
          id: config.defaultModel,
          name: config.defaultModel,
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    return "env";
  }

  private async registerWithSdk(
    provider: ProviderConfig,
    apiKey = provider.apiKey || undefined,
  ): Promise<void> {
    const providerModels = provider.models.map((model) => ({
      type: "chat" as const,
      id: model.id,
      name: model.name,
      api: "openai-completions" as const,
      baseUrl: provider.baseUrl,
      reasoning: model.reasoning ?? false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 128000,
      maxTokens: model.maxTokens ?? 4096,
      compat: model.compat,
    }));

    this.modelRuntime.registerProvider(provider.name, {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: "openai-completions",
      headers: providerRequestHeaders(provider.headers, apiKey),
      authHeader: !!apiKey,
      models: providerModels,
    });

    if (apiKey) {
      await this.modelRuntime.setRuntimeApiKey(provider.name, apiKey);
    }
  }
}

export const modelService = new ModelService();
