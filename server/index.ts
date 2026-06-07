import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "./store.js";

const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
const envPanelPassword = process.env.PANEL_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const adminToken = process.env.ADMIN_TOKEN;
const host = process.env.HOST ?? "127.0.0.1";
const healthIntervalMs = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 10 * 60 * 1000);
const routeCheckIntervalMs = Number(process.env.ROUTE_CHECK_INTERVAL_MS ?? 10 * 60 * 1000);
const recoverIntervalMs = Number(process.env.RECOVER_CHECK_INTERVAL_MS ?? 15 * 60 * 1000);
const maxLoginAttempts = Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5);
const lockMinutes = Number(process.env.LOGIN_LOCK_MINUTES ?? 10);
const store = new Store(dataDir);
const port = Number(process.env.PORT ?? store.all().settings.port ?? 3127);
const app = express();
let server: Server | undefined;

function getEffectivePassword(): string | undefined {
  return store.all().settings.panelPassword || envPanelPassword;
}

const SESSION_COOKIE = "api_hub_session";
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const sessions = new Map<string, { createdAt: number }>();
const loginAttempts = new Map<string, { count: number; lockedUntil?: number }>();

app.use(express.json({ limit: "10mb" }));

function parseCookies(req: express.Request): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.split("=");
    cookies[name.trim()] = rest.join("=").trim();
  }
  return cookies;
}

function createSession(): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getClientIp(req: express.Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || req.socket.remoteAddress || "unknown";
}

function checkLoginLock(ip: string): { locked: boolean; remaining?: number } {
  const attempt = loginAttempts.get(ip);
  if (!attempt?.lockedUntil) return { locked: false };
  if (Date.now() < attempt.lockedUntil) return { locked: true, remaining: Math.ceil((attempt.lockedUntil - Date.now()) / 60000) };
  loginAttempts.delete(ip);
  return { locked: false };
}

function recordLoginFailure(ip: string) {
  const attempt = loginAttempts.get(ip) ?? { count: 0 };
  attempt.count += 1;
  if (attempt.count >= maxLoginAttempts) {
    attempt.lockedUntil = Date.now() + lockMinutes * 60 * 1000;
  }
  loginAttempts.set(ip, attempt);
}

function clearLoginAttempts(ip: string) {
  loginAttempts.delete(ip);
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()), port });
});

app.post("/api/auth/login", (req, res) => {
  const ip = getClientIp(req);
  const lock = checkLoginLock(ip);
  if (lock.locked) return res.status(423).json({ error: `登录已锁定，请 ${lock.remaining} 分钟后重试` });
  const effectivePassword = getEffectivePassword();
  if (!effectivePassword) return res.status(500).json({ error: "面板密码未配置" });
  const password = String(req.body?.password ?? "");
  if (password !== effectivePassword) {
    recordLoginFailure(ip);
    const attempt = loginAttempts.get(ip);
    const remaining = maxLoginAttempts - (attempt?.count ?? 0);
    return res.status(401).json({ error: `密码错误${remaining > 0 ? `，还可尝试 ${remaining} 次` : ""}` });
  }
  clearLoginAttempts(ip);
  const token = createSession();
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}`);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/api/auth/status", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  const effectivePassword = getEffectivePassword();
  const auth = req.header("authorization") ?? "";
  const adminTokenAuthenticated = Boolean(adminToken && auth === `Bearer ${adminToken}`);
  const authenticated = effectivePassword ? isValidSession(token) : adminToken ? adminTokenAuthenticated : true;
  res.json({ authenticated, panelPasswordEnabled: Boolean(effectivePassword), adminTokenEnabled: Boolean(adminToken) });
});

const requirePanelSession: express.RequestHandler = (req, res, next) => {
  if (req.path === "/auth/login" || req.path === "/auth/status") return next();
  const effectivePassword = getEffectivePassword();
  if (!effectivePassword) {
    if (adminToken) {
      const auth = req.header("authorization") ?? "";
      if (auth === `Bearer ${adminToken}`) return next();
      return res.status(401).json({ error: "Missing or invalid ADMIN_TOKEN" });
    }
    return next();
  }
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (isValidSession(token)) return next();
  res.status(401).json({ error: "Panel login required" });
};

const requireClientApiKey: express.RequestHandler = (req, res, next) => {
  const auth = req.header("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: { message: "Missing API key", type: "invalid_request_error" } });
  const clientKey = store.findClientKey(token);
  if (!clientKey) return res.status(401).json({ error: { message: "Invalid API key", type: "invalid_request_error" } });
  store.markClientKeyUsed(clientKey.id);
  return next();
};

app.use("/api", requirePanelSession);
app.use("/v1", requireClientApiKey);

app.get("/api/state", (_req, res) => {
  res.json(store.publicState());
});

app.post("/api/providers", (req, res, next) => {
  try {
    res.status(201).json(store.createProvider(req.body));
  } catch (error) {
    next(error);
  }
});

app.put("/api/providers/:id", (req, res, next) => {
  try {
    res.json(store.updateProvider(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/providers/:id", (req, res, next) => {
  try {
    store.deleteProvider(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/providers/:id/test", async (req, res, next) => {
  try {
    const provider = store.all().providers.find((item) => item.id === req.params.id);
    if (!provider) return res.status(404).json({ error: "Provider not found" });
    const key = chooseKey(provider);
    if (!key) return res.status(400).json({ error: "No enabled API key configured" });
    const started = Date.now();
    const response = await upstreamFetch(provider, key.value, "/models", {
      method: "GET",
      signal: AbortSignal.timeout(provider.timeoutMs)
    });
    const body = await safeJson(response);
    store.updateKeyStatus(provider.id, key.id, {
      status: response.ok ? "healthy" : "unhealthy",
      latencyMs: Date.now() - started,
      error: response.ok ? undefined : `HTTP ${response.status}`
    });
    res.json({
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      models: Array.isArray(body?.data) ? body.data.slice(0, 20) : []
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/providers/:id/keys", (req, res, next) => {
  try {
    res.json(store.addApiKeys(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});

app.get("/api/providers/:id/keys", (req, res, next) => {
  try {
    res.json({ keys: store.revealApiKeys(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/providers/:id/keys/:keyId", (req, res, next) => {
  try {
    res.json(store.deleteKey(req.params.id, req.params.keyId));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/providers/:id/keys/:keyId", (req, res, next) => {
  try {
    const enabled = req.body?.enabled;
    const label = req.body?.label;
    if (enabled === undefined && label === undefined) return res.status(400).json({ error: "No fields to update" });
    res.json(store.updateKey(req.params.id, req.params.keyId, { enabled, label }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/providers/:id/sync-models", async (req, res, next) => {
  try {
    const keyId = String(req.body?.keyId ?? "");
    if (keyId) {
      const result = await syncProviderKey(req.params.id, keyId, Boolean(req.body?.createRoutes ?? false));
      return res.json(result);
    }
    const results = await syncProviderAllKeys(req.params.id, Boolean(req.body?.createRoutes ?? false));
    res.json({ keyCount: results.length, results });
  } catch (error) {
    next(error);
  }
});

app.post("/api/providers/:id/keys/:keyId/sync", async (req, res, next) => {
  try {
    const result = await syncProviderKey(req.params.id, req.params.keyId, Boolean(req.body?.createRoutes ?? false));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/providers/sync-all", async (_req, res, next) => {
  try {
    const results = await syncAllProviders();
    res.json({ synced: results.length, results });
  } catch (error) {
    next(error);
  }
});

app.post("/api/routes", (req, res, next) => {
  try {
    res.status(201).json(store.createRoute(req.body));
  } catch (error) {
    next(error);
  }
});

app.put("/api/routes/:id", (req, res, next) => {
  try {
    res.json(store.updateRoute(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/routes/:id", (req, res, next) => {
  try {
    store.deleteRoute(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/routes/cleanup-invalid", (_req, res, next) => {
  try {
    res.json(store.cleanupInvalidRoutes());
  } catch (error) {
    next(error);
  }
});

app.post("/api/routes/:id/recover", async (req, res, next) => {
  try {
    try {
      const result = await probeRoute(req.params.id, { restoreOnSuccess: true, failureSource: "recover" });
      const route = store.publicState().routes.find((item) => item.id === req.params.id);
      res.json({ ...result, route });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Recover probe failed";
      store.recordRouteResult(req.params.id, false, 0, message, { failureSource: "recover" });
      const route = store.publicState().routes.find((item) => item.id === req.params.id);
      res.json({ ok: false, status: 0, latencyMs: 0, error: message, route });
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/routes/:id/probe", async (req, res, next) => {
  try {
    res.json(await probeRoute(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/models/:alias/probe", async (req, res, next) => {
  try {
    const alias = decodeURIComponent(req.params.alias);
    const routes = store.all().routes.filter((route) => route.alias === alias && route.enabled && route.status !== "invalid");
    const results = [];
    for (const route of routes) {
      try {
        results.push({ routeId: route.id, ...(await probeRoute(route.id)) });
      } catch (error) {
        store.recordRouteResult(route.id, false, 0, error instanceof Error ? error.message : "Probe failed", { failureSource: "probe" });
        results.push({ routeId: route.id, ok: false, status: 0, latencyMs: 0, error: error instanceof Error ? error.message : "Probe failed" });
      }
    }
    res.json({ alias, count: results.length, results });
  } catch (error) {
    next(error);
  }
});

app.post("/api/repair/run", async (_req, res, next) => {
  try {
    const syncResults = await syncAllProviders();
    const recoverResults = await recoverInvalidRoutes();
    res.json({
      synced: syncResults.length,
      syncResults,
      recovered: recoverResults.filter((item) => item.ok).length,
      recoverResults
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", (req, res, next) => {
  try {
    res.json({ ...store.updateSettings(req.body), requiresRestart: true, currentPort: port });
  } catch (error) {
    next(error);
  }
});

app.put("/api/model-settings/:alias", (req, res, next) => {
  try {
    const strategy = String(req.body?.strategy ?? "fixed");
    if (!["fixed", "fastest", "priority", "cost", "random"].includes(strategy)) {
      return res.status(400).json({ error: "Invalid strategy" });
    }
    const routeId = typeof req.body?.routeId === "string" ? req.body.routeId : undefined;
    res.json(store.updateModelSetting(req.params.alias, strategy as "fixed" | "fastest" | "priority" | "cost" | "random", routeId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/diagnostics", (_req, res) => {
  const state = store.publicState();
  const issues = [];
  const aliases = new Map<string, typeof state.routes>();
  for (const route of state.routes) aliases.set(route.alias, [...(aliases.get(route.alias) ?? []), route]);

  for (const provider of state.providers) {
    if (!provider.apiKeySet) issues.push({ level: "warning", message: `供应商 ${provider.name} 没有 API Key` });
    if (provider.enabled && provider.healthStatus === "unhealthy") issues.push({ level: "error", message: `供应商 ${provider.name} 最近健康检查失败` });
  }
  for (const [alias, routes] of aliases) {
    const active = routes.filter((route) => route.enabled && route.status !== "invalid");
    if (active.length === 0) issues.push({ level: "error", message: `模型 ${alias} 没有可用候选` });
    if (active.length === 1) issues.push({ level: "info", message: `模型 ${alias} 只有 1 个候选，无法故障切换` });
    if (active.some((route) => route.disabledUntil && new Date(route.disabledUntil).getTime() > Date.now())) {
      issues.push({ level: "warning", message: `模型 ${alias} 有候选正在熔断` });
    }
  }
  res.json({ issues });
});

app.get("/api/logs", (_req, res) => {
  res.json(store.publicState().logs);
});

app.delete("/api/logs", (_req, res, next) => {
  try {
    store.clearLogs();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/config/export", (req, res) => {
  const includeSecrets = req.query.includeSecrets === "true";
  res.setHeader("content-disposition", `attachment; filename="api-hub-config-${includeSecrets ? "full" : "safe"}.json"`);
  res.json(store.exportConfig(includeSecrets));
});

app.post("/api/config/import", (req, res, next) => {
  try {
    res.json(store.importConfig(req.body));
  } catch (error) {
    next(error);
  }
});

app.get("/api/client-keys", (_req, res) => {
  res.json({ keys: store.publicClientKeys() });
});

app.get("/api/client-keys/reveal", (_req, res) => {
  res.json({ keys: store.revealClientKeys() });
});

app.post("/api/client-keys", (req, res, next) => {
  try {
    const label = String(req.body?.label ?? "");
    const value = typeof req.body?.value === "string" ? req.body.value : undefined;
    res.status(201).json(store.createClientKey(label, value));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/client-keys/:id", (req, res, next) => {
  try {
    const enabled = req.body?.enabled;
    const label = req.body?.label;
    if (enabled === undefined && label === undefined) return res.status(400).json({ error: "No fields to update" });
    res.json(store.updateClientKey(req.params.id, { enabled, label }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/client-keys/:id", (req, res, next) => {
  try {
    store.deleteClientKey(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/v1/models", (_req, res) => {
  const state = store.publicState();
  const grouped = new Map<string, { providers: Set<string>; bestLatency?: number; candidateCount: number }>();
  for (const route of state.routes.filter((route) => route.enabled && route.status !== "invalid")) {
    const provider = state.providers.find((item) => item.id === route.providerId);
    const current = grouped.get(route.alias) ?? { providers: new Set<string>(), bestLatency: undefined, candidateCount: 0 };
    current.providers.add(provider?.name ?? "local");
    current.candidateCount += 1;
    const latency = route.latencyMs ?? provider?.latencyMs;
    if (latency !== undefined) current.bestLatency = Math.min(current.bestLatency ?? latency, latency);
    grouped.set(route.alias, current);
  }
  const routeModels = [...grouped.entries()].map(([id, meta]) => ({
    id,
    object: "model",
    owned_by: [...meta.providers].join(", "),
    candidates: meta.candidateCount,
    best_latency_ms: meta.bestLatency
  }));
  res.json({ object: "list", data: routeModels });
});

app.post("/v1/chat/completions", async (req, res, next) => {
  try {
    const model = String(req.body?.model ?? "");
    const candidates = store.resolveCandidates(model);
    if (candidates.length === 0) return res.status(400).json({ error: { message: "No enabled provider configured" } });

    let lastError: { statusCode: number; body: string; message: string } | undefined;
    for (const candidate of candidates) {
      const key = chooseRouteKey(candidate.provider, candidate.route.keyId);
      if (!key) continue;

      const body = {
        ...req.body,
        model: candidate.route.upstreamModel
      };

      const started = Date.now();
      try {
        const upstream = await upstreamFetch(candidate.provider, key.value, "/chat/completions", {
          method: "POST",
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(candidate.provider.timeoutMs)
        });
        const latencyMs = Date.now() - started;

        if (!upstream.ok && shouldRetry(upstream.status)) {
          const text = await upstream.text();
          store.recordRouteResult(candidate.route.id, false, latencyMs, `HTTP ${upstream.status}`, { failureSource: "chat" });
          store.addLog({
            model,
            providerId: candidate.provider.id,
            providerName: candidate.provider.name,
            routeId: candidate.route.id,
            upstreamModel: candidate.route.upstreamModel,
            status: "retried",
            statusCode: upstream.status,
            latencyMs,
            error: `HTTP ${upstream.status}`
          });
          lastError = { statusCode: upstream.status, body: text, message: `HTTP ${upstream.status}` };
          continue;
        }

        store.recordRouteResult(candidate.route.id, upstream.ok, latencyMs, upstream.ok ? undefined : `HTTP ${upstream.status}`, { failureSource: "chat" });

        res.status(upstream.status);
        upstream.headers.forEach((value, header) => {
          if (!["content-encoding", "content-length", "transfer-encoding"].includes(header.toLowerCase())) {
            res.setHeader(header, value);
          }
        });

        if (!upstream.body) {
          res.end();
          return;
        }

        if (req.body?.stream) {
          store.addLog({
            model,
            providerId: candidate.provider.id,
            providerName: candidate.provider.name,
            routeId: candidate.route.id,
            upstreamModel: candidate.route.upstreamModel,
            status: upstream.ok ? "success" : "failed",
            statusCode: upstream.status,
            latencyMs,
            error: upstream.ok ? undefined : `HTTP ${upstream.status}`
          });
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
          return;
        }

        const responseBody = await upstream.json().catch(() => null);
        const usage = parseUsage(responseBody);
        store.addLog({
          model,
          providerId: candidate.provider.id,
          providerName: candidate.provider.name,
          routeId: candidate.route.id,
          upstreamModel: candidate.route.upstreamModel,
          status: upstream.ok ? "success" : "failed",
          statusCode: upstream.status,
          latencyMs,
          error: upstream.ok ? undefined : `HTTP ${upstream.status}`,
          ...(usage ?? {})
        });
        res.json(responseBody);
        return;
      } catch (error) {
        const latencyMs = Date.now() - started;
        const message = error instanceof Error ? error.message : "Unknown upstream error";
        store.recordRouteResult(candidate.route.id, false, latencyMs, message, { failureSource: "chat" });
        store.addLog({
          model,
          providerId: candidate.provider.id,
          providerName: candidate.provider.name,
          routeId: candidate.route.id,
          upstreamModel: candidate.route.upstreamModel,
          status: "retried",
          latencyMs,
          error: message
        });
        lastError = { statusCode: 502, body: "", message };
      }
    }

    res.status(lastError?.statusCode ?? 502).send(lastError?.body || JSON.stringify({ error: { message: lastError?.message ?? "All candidates failed" } }));
  } catch (error) {
    next(error);
  }
});

app.post("/v1/embeddings", (req, res, next) => {
  proxyOpenAiEndpoint(req, res, next, "/embeddings", false).catch(next);
});

app.post("/v1/images/generations", (req, res, next) => {
  proxyOpenAiEndpoint(req, res, next, "/images/generations", false).catch(next);
});

app.post("/v1/responses", (req, res, next) => {
  proxyOpenAiEndpoint(req, res, next, "/responses", Boolean(req.body?.stream)).catch(next);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, "../dist");
app.use(express.static(staticDir));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500;
  const message = error instanceof Error ? error.message : "Unknown error";
  res.status(statusCode).json({ error: message });
});

export function startServer() {
  if (server) return server;
  server = app.listen(port, host, () => {
    console.log(`API Hub listening on http://${host}:${port}`);
  });
  return server;
}

export function stopServer() {
  return new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      server = undefined;
      resolve();
    });
  });
}

export function isServerRunning() {
  return Boolean(server?.listening);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

if (healthIntervalMs > 0) {
  setInterval(() => {
    runHealthChecks().catch((error) => console.error("Health check failed", error));
  }, healthIntervalMs).unref();
}

if (routeCheckIntervalMs > 0) {
  setInterval(() => {
    runRouteProbes().catch((error) => console.error("Route probe failed", error));
  }, routeCheckIntervalMs).unref();
}

if (recoverIntervalMs > 0) {
  setInterval(() => {
    recoverInvalidRoutes().catch((error) => console.error("Route recover failed", error));
  }, recoverIntervalMs).unref();
}

function upstreamFetch(provider: { baseUrl: string }, apiKey: string, endpoint: string, init: RequestInit) {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return fetch(`${baseUrl}/v1${endpoint}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {})
    }
  });
}

function chooseKey(provider: { apiKeys: { value: string; enabled: boolean; status: string; id: string }[] }) {
  return (
    provider.apiKeys.find((key) => key.enabled && key.status === "healthy") ??
    provider.apiKeys.find((key) => key.enabled && key.status !== "unhealthy") ??
    provider.apiKeys.find((key) => key.enabled)
  );
}

function chooseRouteKey(provider: { apiKeys: { value: string; enabled: boolean; status: string; id: string }[] }, keyId?: string) {
  if (!keyId) return chooseKey(provider);
  return provider.apiKeys.find((key) => key.id === keyId && key.enabled) ?? null;
}

function shouldRetry(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function syncProviderKey(providerId: string, keyId: string, createRoutes: boolean) {
  const provider = store.all().providers.find((item) => item.id === providerId);
  if (!provider) {
    const error = new Error("Provider not found");
    Object.assign(error, { statusCode: 404 });
    throw error;
  }
  const key = provider.apiKeys.find((item) => item.id === keyId);
  if (!key) {
    const error = new Error("API Key not found");
    Object.assign(error, { statusCode: 404 });
    throw error;
  }

  const started = Date.now();
  const response = await upstreamFetch(provider, key.value, "/models", {
    method: "GET",
    signal: AbortSignal.timeout(provider.timeoutMs)
  });
  const body = await safeJson(response);
  store.updateKeyStatus(provider.id, key.id, {
    status: response.ok ? "healthy" : "unhealthy",
    latencyMs: Date.now() - started,
    error: response.ok ? undefined : `HTTP ${response.status}`
  });
  const modelIds = Array.isArray(body?.data)
    ? body.data.map((item: { id?: unknown }) => String(item.id ?? "")).filter(Boolean)
    : [];
  const result = store.syncKeyModels(providerId, keyId, modelIds, createRoutes, Date.now() - started);
  return { provider: result, keyId, modelCount: modelIds.length, ok: response.ok, status: response.status, latencyMs: Date.now() - started };
}

async function syncProviderAllKeys(providerId: string, createRoutes: boolean) {
  const results: { keyId: string; modelCount: number; ok: boolean; error?: string }[] = [];
  const provider = store.all().providers.find((item) => item.id === providerId);
  if (!provider) {
    const error = new Error("Provider not found");
    Object.assign(error, { statusCode: 404 });
    throw error;
  }
  for (const key of provider.apiKeys.filter((k) => k.enabled)) {
    try {
      const result = await syncProviderKey(providerId, key.id, createRoutes);
      results.push({ keyId: key.id, modelCount: result.modelCount, ok: true });
    } catch (error) {
      results.push({ keyId: key.id, modelCount: 0, ok: false, error: error instanceof Error ? error.message : "Sync failed" });
    }
  }
  return results;
}

async function syncAllProviders() {
  const results: { providerId: string; name: string; keyCount: number; modelCount: number; error?: string }[] = [];
  const providers = store.all().providers.filter((provider) => provider.enabled && provider.apiKeys.some((key) => key.enabled));
  for (const provider of providers) {
    try {
      const keyResults = await syncProviderAllKeys(provider.id, false);
      const totalModels = keyResults.reduce((s, r) => s + r.modelCount, 0);
      const failedKeys = keyResults.filter((r) => !r.ok).length;
      results.push({ providerId: provider.id, name: provider.name, keyCount: keyResults.length, modelCount: totalModels, error: failedKeys > 0 ? `${failedKeys}/${keyResults.length} 个 Key 同步失败` : undefined });
    } catch (error) {
      results.push({ providerId: provider.id, name: provider.name, keyCount: 0, modelCount: 0, error: error instanceof Error ? error.message : "Sync failed" });
    }
  }
  return results;
}

async function runHealthChecks() {
  const providers = store.all().providers.filter((provider) => provider.enabled && provider.apiKeys.some((key) => key.enabled));
  for (const provider of providers) {
    const enabledKeys = provider.apiKeys.filter((k) => k.enabled);
    for (const key of enabledKeys) {
      try {
        await syncProviderKey(provider.id, key.id, false);
      } catch (error) {
        console.error(`Health check failed for ${provider.name}/${key.label}:`, error instanceof Error ? error.message : error);
      }
    }
  }
}

async function probeRoute(routeId: string, options: { restoreOnSuccess?: boolean; failureSource?: "probe" | "recover" } = {}) {
  const state = store.all();
  const route = state.routes.find((item) => item.id === routeId);
  const provider = route ? state.providers.find((item) => item.id === route.providerId) : undefined;
  if (!route || !provider) {
    const error = new Error("Route not found");
    Object.assign(error, { statusCode: 404 });
    throw error;
  }
  const key = chooseRouteKey(provider, route.keyId);
  if (!key) {
    const error = new Error("No enabled API key configured");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  const started = Date.now();
  const response = await upstreamFetch(provider, key.value, "/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: route.upstreamModel,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0
    }),
    signal: AbortSignal.timeout(provider.timeoutMs)
  });
  const latencyMs = Date.now() - started;
  store.recordRouteResult(route.id, response.ok, latencyMs, response.ok ? undefined : `HTTP ${response.status}`, {
    failureSource: options.failureSource ?? "probe",
    restoreOnSuccess: options.restoreOnSuccess
  });
  store.addLog({
    model: route.alias,
    providerId: provider.id,
    providerName: provider.name,
    routeId: route.id,
    upstreamModel: route.upstreamModel,
    status: response.ok ? "success" : "failed",
    statusCode: response.status,
    latencyMs,
    error: response.ok ? undefined : `probe HTTP ${response.status}`
  });
  return { ok: response.ok, status: response.status, latencyMs };
}

async function runRouteProbes() {
  const routes = store.all().routes.filter((route) => route.enabled && route.status !== "invalid");
  for (const route of routes) {
    try {
      await probeRoute(route.id);
    } catch (error) {
      store.recordRouteResult(route.id, false, 0, error instanceof Error ? error.message : "Probe failed", { failureSource: "probe" });
    }
  }
}

async function recoverInvalidRoutes() {
  const routes = store.all().routes.filter((route) => route.status === "invalid");
  const results: { routeId: string; alias: string; upstreamModel: string; ok: boolean; status?: number; latencyMs?: number; error?: string }[] = [];
  for (const route of routes) {
    try {
      const result = await probeRoute(route.id, { restoreOnSuccess: true, failureSource: "recover" });
      results.push({ routeId: route.id, alias: route.alias, upstreamModel: route.upstreamModel, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Recover probe failed";
      store.recordRouteResult(route.id, false, 0, message, { failureSource: "recover" });
      results.push({ routeId: route.id, alias: route.alias, upstreamModel: route.upstreamModel, ok: false, error: message });
    }
  }
  return results;
}

async function proxyOpenAiEndpoint(req: express.Request, res: express.Response, _next: express.NextFunction, endpoint: string, stream: boolean) {
  const model = String(req.body?.model ?? "");
  const candidates = store.resolveCandidates(model);
  if (!model || candidates.length === 0) return res.status(400).json({ error: { message: "No enabled route configured for model" } });

  let lastError: { statusCode: number; body: string; message: string } | undefined;
  for (const candidate of candidates) {
    const key = chooseRouteKey(candidate.provider, candidate.route.keyId);
    if (!key) continue;
    const started = Date.now();
    try {
      const upstream = await upstreamFetch(candidate.provider, key.value, endpoint, {
        method: "POST",
        body: JSON.stringify({ ...req.body, model: candidate.route.upstreamModel }),
        signal: AbortSignal.timeout(candidate.provider.timeoutMs)
      });
      const latencyMs = Date.now() - started;
      if (!upstream.ok && shouldRetry(upstream.status)) {
        const text = await upstream.text();
        store.recordRouteResult(candidate.route.id, false, latencyMs, `HTTP ${upstream.status}`, { failureSource: "chat" });
        store.addLog({ model, providerId: candidate.provider.id, providerName: candidate.provider.name, routeId: candidate.route.id, upstreamModel: candidate.route.upstreamModel, status: "retried", statusCode: upstream.status, latencyMs, error: `${endpoint} HTTP ${upstream.status}` });
        lastError = { statusCode: upstream.status, body: text, message: `HTTP ${upstream.status}` };
        continue;
      }

      store.recordRouteResult(candidate.route.id, upstream.ok, latencyMs, upstream.ok ? undefined : `HTTP ${upstream.status}`, { failureSource: "chat" });
      store.addLog({ model, providerId: candidate.provider.id, providerName: candidate.provider.name, routeId: candidate.route.id, upstreamModel: candidate.route.upstreamModel, status: upstream.ok ? "success" : "failed", statusCode: upstream.status, latencyMs, error: upstream.ok ? undefined : `${endpoint} HTTP ${upstream.status}` });

      res.status(upstream.status);
      upstream.headers.forEach((value, header) => {
        if (!["content-encoding", "content-length", "transfer-encoding"].includes(header.toLowerCase())) res.setHeader(header, value);
      });
      if (!upstream.body) return res.end();
      if (stream) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
        return;
      }
      res.send(Buffer.from(await upstream.arrayBuffer()));
      return;
    } catch (error) {
      const latencyMs = Date.now() - started;
      const message = error instanceof Error ? error.message : "Unknown upstream error";
      store.recordRouteResult(candidate.route.id, false, latencyMs, message, { failureSource: "chat" });
      store.addLog({ model, providerId: candidate.provider.id, providerName: candidate.provider.name, routeId: candidate.route.id, upstreamModel: candidate.route.upstreamModel, status: "retried", latencyMs, error: `${endpoint} ${message}` });
      lastError = { statusCode: 502, body: "", message };
    }
  }

  return res.status(lastError?.statusCode ?? 502).send(lastError?.body || JSON.stringify({ error: { message: lastError?.message ?? "All candidates failed" } }));
}

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseUsage(body: unknown) {
  if (!body || typeof body !== "object" || !("usage" in body)) return undefined;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage) return undefined;
  return {
    promptTokens: readNumber(usage.prompt_tokens),
    completionTokens: readNumber(usage.completion_tokens),
    totalTokens: readNumber(usage.total_tokens)
  };
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
