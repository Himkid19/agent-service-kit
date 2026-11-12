import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelService } from "../src/services/model.service.js";
import { providerRepository } from "../src/repositories/provider.repository.js";
import { config } from "../src/config.js";
import { resetTables } from "./db-test-utils.js";

const PROVIDER = "trace-header-test";

let agentDir: string;

describe("LLM request trace headers", () => {
  beforeAll(async () => {
    config.llmTraceIdentifier = "test-trace";
    config.llmTraceIdentifierType = "test";
    await resetTables("provider_models", "providers");
    agentDir = mkdtempSync(join(tmpdir(), "trace-hdr-"));
    await modelService.init(agentDir);
    await providerRepository.createOrUpdate({
      name: PROVIDER,
      baseUrl: "http://trace-base.example/v1",
      apiKey: "trace-key",
      models: [{ id: "model-a", name: "model-a" }],
    });
  });

  afterAll(() => {
    config.llmTraceIdentifier = "";
    config.llmTraceIdentifierType = "";
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("attaches x-trace-identifier and x-trace-identifier-type to outbound LLM requests", async () => {
    const model = await modelService.resolveModel(PROVIDER, "model-a");
    const auth = await modelService.modelRuntime.getAuth(model);
    expect(auth?.auth.headers?.["x-trace-identifier"]).toBe(config.llmTraceIdentifier);
    expect(auth?.auth.headers?.["x-trace-identifier-type"]).toBe(config.llmTraceIdentifierType);
    expect(auth?.auth.headers?.Authorization).toBe("Bearer trace-key");
  });

  it("keeps custom provider headers while applying configured trace headers", async () => {
    await providerRepository.createOrUpdate({
      name: PROVIDER,
      baseUrl: "http://trace-base.example/v1",
      apiKey: "trace-key",
      headers: { "x-trace-identifier": "stale", "X-Custom": "yes" },
      models: [{ id: "model-a", name: "model-a" }],
    });
    const model = await modelService.resolveModel(PROVIDER, "model-a");
    const auth = await modelService.modelRuntime.getAuth(model);
    expect(auth?.auth.headers?.["x-trace-identifier"]).toBe(config.llmTraceIdentifier);
    expect(auth?.auth.headers?.["x-trace-identifier-type"]).toBe(config.llmTraceIdentifierType);
    expect(auth?.auth.headers?.["X-Custom"]).toBe("yes");
  });
});
