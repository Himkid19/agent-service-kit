import { randomUUID } from "node:crypto";
import { db, toMySqlDateTime } from "../db.js";
import type { ProviderConfig, ProviderModel } from "../types.js";

export interface StoredProvider extends ProviderConfig {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProviderModel extends ProviderModel {
  id: string;
  providerId: string;
  modelId: string;
}

interface ProviderRow {
  id: string;
  name: string;
  display_name: string | null;
  base_url: string;
  api_key: string | null;
  headers: string | null;
  created_at: string;
  updated_at: string;
}

interface ProviderModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  name: string;
  api: string | null;
  context_window: number | null;
  max_tokens: number | null;
  reasoning: number;
  compat: string | null;
}

class ProviderRepository {
  async createOrUpdate(cfg: ProviderConfig): Promise<StoredProvider> {
    const existing = await this.findByName(cfg.name);
    const id = existing?.id ?? randomUUID();
    const now = toMySqlDateTime(new Date().toISOString());

    if (existing) {
      await db.execute(
        `UPDATE providers
         SET display_name = ?, base_url = ?, api_key = ?, headers = ?, updated_at = ?
         WHERE id = ?`,
        [cfg.displayName ?? null, cfg.baseUrl, cfg.apiKey ?? null, cfg.headers ? JSON.stringify(cfg.headers) : null, now, id],
      );
      await db.execute("DELETE FROM provider_models WHERE provider_id = ?", [id]);
    } else {
      await db.execute(
        `INSERT INTO providers (id, name, display_name, base_url, api_key, headers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, cfg.name, cfg.displayName ?? null, cfg.baseUrl, cfg.apiKey ?? null, cfg.headers ? JSON.stringify(cfg.headers) : null, now, now],
      );
    }

    for (const m of cfg.models) {
      await db.execute(
        `INSERT INTO provider_models (id, provider_id, model_id, name, api, context_window, max_tokens, reasoning, compat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          id,
          m.id,
          m.name,
          m.api ?? null,
          m.contextWindow ?? null,
          m.maxTokens ?? null,
          m.reasoning ? 1 : 0,
          m.compat ? JSON.stringify(m.compat) : null,
        ],
      );
    }

    return { ...cfg, id, createdAt: existing?.createdAt ?? now, updatedAt: now };
  }

  async findByName(name: string): Promise<StoredProvider | undefined> {
    const rows = await db.query("SELECT * FROM providers WHERE name = ?", [name]);
    if (rows.length === 0) return undefined;
    const row = rows[0] as unknown as ProviderRow;
    const models = await this.loadModels(row.id);
    return this.rowToStoredProvider(row, models);
  }

  async list(): Promise<StoredProvider[]> {
    const rows = await db.query("SELECT * FROM providers ORDER BY created_at DESC");
    return Promise.all(
      rows.map(async (r) => {
        const row = r as unknown as ProviderRow;
        const models = await this.loadModels(row.id);
        return this.rowToStoredProvider(row, models);
      }),
    );
  }

  async deleteByName(name: string): Promise<void> {
    await db.execute("DELETE FROM providers WHERE name = ?", [name]);
  }

  async deleteAll(): Promise<void> {
    await db.execute("DELETE FROM providers");
  }

  private async loadModels(providerId: string): Promise<StoredProviderModel[]> {
    const rows = await db.query(
      "SELECT * FROM provider_models WHERE provider_id = ? ORDER BY name",
      [providerId],
    );
    return rows.map((r) => {
      const row = r as unknown as ProviderModelRow;
      return {
        id: row.model_id,
        providerId: row.provider_id,
        modelId: row.model_id,
        name: row.name,
        api: row.api ?? undefined,
        contextWindow: row.context_window ?? undefined,
        maxTokens: row.max_tokens ?? undefined,
        reasoning: Boolean(row.reasoning),
        compat: row.compat && typeof row.compat === "object" ? row.compat : row.compat ? JSON.parse(row.compat) : undefined,
      };
    });
  }

  private rowToStoredProvider(row: ProviderRow, models: StoredProviderModel[]): StoredProvider {
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name ?? undefined,
      baseUrl: row.base_url,
      apiKey: row.api_key ?? undefined,
      headers: row.headers && typeof row.headers === "object" ? row.headers : row.headers ? JSON.parse(row.headers) : undefined,
      models: models.map((m) => ({
        id: m.modelId,
        name: m.name,
        api: m.api,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning,
        compat: m.compat,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const providerRepository = new ProviderRepository();
