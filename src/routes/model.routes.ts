import { Router } from "express";
import { modelService } from "../services/model.service.js";
import { authRequired, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.use(authRequired);

/** List all available models */
router.get("/", async (req: AuthenticatedRequest, res, next) => {
  try {
    const models = await modelService.getAvailableModels();
    res.json({
      models: models.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/** Register a custom provider (e.g. OpenAI-compatible) */
router.post("/providers", async (req: AuthenticatedRequest, res, next) => {
  try {
    const { name, baseUrl, apiKey, headers, models } = req.body;
    if (!name || !baseUrl || !models?.length) {
      res.status(400).json({ error: "name, baseUrl, and models are required" });
      return;
    }
    await modelService.registerProvider({ name, baseUrl, apiKey, headers, models });
    res.status(201).json({ ok: true, provider: name });
  } catch (e) {
    next(e);
  }
});

/** List registered custom providers */
router.get("/providers", async (req: AuthenticatedRequest, res, next) => {
  try {
    const providers = await modelService.listProviders();
    res.json({ providers });
  } catch (e) {
    next(e);
  }
});

/** Delete a custom provider */
router.delete("/providers/:name", async (req: AuthenticatedRequest, res, next) => {
  try {
    await modelService.unregisterProvider(req.params.name);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
