import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelService } from "../src/services/model.service.js";
import { providerRepository } from "../src/repositories/provider.repository.js";
import { config } from "../src/config.js";
import { resetTables } from "./db-test-utils.js";

const PROVIDER = "precedence-test";

let agentDir: string;
let savedEnv: { apiKey: string; baseUrl: string; name: string };

async function resolvedAuth(provider: string, modelId: string) {
  const model = await modelService.resolveModel(provider, modelId);
  const auth = await modelService.modelRuntime.getAuth(model);
  return { model, auth };
}

describe("provider resolution precedence (MySQL over .env)", () => {
  beforeAll(async () => {
    await resetTables("provider_models", "providers");
    agentDir = mkdtempSync(join(tmpdir(), "model-svc-"));
    await modelService.init(agentDir);
    savedEnv = {
      apiKey: config.providerApiKey,
      baseUrl: config.providerBaseUrl,
      name: config.providerName,
    };
    config.providerName = PROVIDER;
    config.providerApiKey = "env-key";
    config.providerBaseUrl = "http://env-base.example/v1";
  });

  afterAll(() => {
    config.providerApiKey = savedEnv.apiKey;
    config.providerBaseUrl = savedEnv.baseUrl;
    config.providerName = savedEnv.name;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("uses the MySQL base_url/api_key even when .env has values for the same provider", async () => {
    await providerRepository.createOrUpdate({
      name: PROVIDER,
      baseUrl: "http://mysql-base.example/v1",
      apiKey: "mysql-key",
      models: [{ id: "model-a", name: "model-a" }],
    });

    const { model, auth } = await resolvedAuth(PROVIDER, "model-a");
    expect(model.baseUrl).toBe("http://mysql-base.example/v1");
    expect(auth?.auth.apiKey).toBe("mysql-key");
    expect(auth?.auth.headers?.Authorization).toBe("Bearer mysql-key");
  });

  it("backfills the api key from .env when the MySQL row has none", async () => {
    await providerRepository.createOrUpdate({
      name: PROVIDER,
      baseUrl: "http://mysql-base.example/v1",
      models: [{ id: "model-a", name: "model-a" }],
    });

    const { model, auth } = await resolvedAuth(PROVIDER, "model-a");
    expect(model.baseUrl).toBe("http://mysql-base.example/v1");
    expect(auth?.auth.apiKey).toBe("env-key");
  });

  it("serves an unlisted model id from the MySQL base_url", async () => {
    await providerRepository.createOrUpdate({
      name: PROVIDER,
      baseUrl: "http://mysql-base.example/v1",
      apiKey: "mysql-key",
      models: [{ id: "model-a", name: "model-a" }],
    });

    const { model, auth } = await resolvedAuth(PROVIDER, "some-other-model");
    expect(model.baseUrl).toBe("http://mysql-base.example/v1");
    expect(auth?.auth.apiKey).toBe("mysql-key");
  });

  it("applyEnvFallback keeps the MySQL row untouched when it exists", async () => {
    await providerRepository.createOrUpdate({
      name: PROVIDER,
      baseUrl: "http://mysql-base.example/v1",
      apiKey: "mysql-key",
      models: [{ id: "model-a", name: "model-a" }],
    });

    const result = await modelService.applyEnvFallback();
    expect(result).toBe("mysql");

    const stored = await providerRepository.findByName(PROVIDER);
    expect(stored?.baseUrl).toBe("http://mysql-base.example/v1");
    expect(stored?.apiKey).toBe("mysql-key");
  });

  it("applyEnvFallback registers the .env provider only when MySQL has no such provider", async () => {
    await providerRepository.deleteByName(PROVIDER);

    const result = await modelService.applyEnvFallback();
    expect(result).toBe("env");

    const stored = await providerRepository.findByName(PROVIDER);
    expect(stored?.baseUrl).toBe("http://env-base.example/v1");
    expect(stored?.apiKey).toBe("env-key");

    const { model } = await resolvedAuth(PROVIDER, config.defaultModel);
    expect(model.baseUrl).toBe("http://env-base.example/v1");
  });
});
