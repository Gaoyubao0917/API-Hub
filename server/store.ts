import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ApiKeyEntry, AppState, ClientApiKey, ModelRoute, ModelStrategy, Provider, ProviderCapability, PublicProvider, RequestLog, RouteFailureSource, SyncedModel } from "./types.js";

export const allCapabilities: ProviderCapability[] = ["chat", "responses", "vision", "image-generation", "image-edit", "files", "audio"];
export const defaultModelCapabilities: ProviderCapability[] = ["chat", "responses"];

const providerSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["openai-compatible", "anthropic-compatible"]).default("openai-compatible"),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().optional().default(""),
  enabled: z.boolean().default(true),
  priority: z.coerce.number().int().min(0).default(50),
  timeoutMs: z.coerce.number().int().min(1000).max(300000).default(60000),
  notes: z.string().optional().default("")
});

const routeSchema = z.object({
  alias: z.string().trim().min(1),
  upstreamModel: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  keyId: z.string().trim().optional(),
  enabled: z.boolean().default(true),
  costTier: z.enum(["low", "medium", "high"]).optional().default("medium"),
  costNote: z.string().optional().default("")
});

const defaultState: AppState = {
  providers: [],
  routes: [],
  logs: [],
  modelSettings: [],
  settings: {
    port: 3127,
    routeFailureThreshold: 1,
    clientApiKeys: []
  }
};

export class Store {
  private readonly filePath: string;
  private readonly backupPath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, "state.json");
    this.backupPath = `${this.filePath}.bak`;
    this.cleanupTemporaryFiles();
    if (!fs.existsSync(this.filePath)) {
      this.write(defaultState);
      return;
    }
    try {
      this.readStateFile(this.filePath);
    } catch (error) {
      if (!this.restoreBackup()) {
        this.quarantineCorruptState();
        this.write(defaultState);
      }
    }
  }

  all(): AppState {
    return this.readStateFile(this.filePath);
  }

  publicState() {
    const state = this.all();
    return {
      providers: state.providers.map(toPublicProvider),
      routes: state.routes,
      logs: state.logs.slice(-200).reverse(),
      modelSettings: state.modelSettings,
      settings: {
        port: state.settings.port,
        routeFailureThreshold: state.settings.routeFailureThreshold,
        clientKeyCount: state.settings.clientApiKeys.length
      }
    };
  }

  createProvider(input: unknown): PublicProvider {
    const data = providerSchema.parse(input);
    const state = this.all();
    const now = new Date().toISOString();
    const provider: Provider = {
      id: nanoid(12),
      ...data,
      apiKeys: data.apiKey.trim() ? [createKey("主 Key", data.apiKey.trim())] : [],
      healthStatus: "unknown",
      createdAt: now,
      updatedAt: now
    };
    delete (provider as unknown as { apiKey?: string }).apiKey;
    state.providers.push(provider);
    this.write(state);
    return toPublicProvider(provider);
  }

  updateProvider(id: string, input: unknown): PublicProvider {
    const data = providerSchema.partial({ apiKey: true }).parse(input);
    const state = this.all();
    const provider = state.providers.find((item) => item.id === id);
    if (!provider) throw notFound("Provider not found");
    if (data.apiKey?.trim()) {
      const first = provider.apiKeys[0];
      if (first) {
        first.value = data.apiKey.trim();
        first.lastCheckedAt = undefined;
      } else {
        provider.apiKeys.push(createKey("主 Key", data.apiKey.trim()));
      }
    }
    const { apiKey: _apiKey, ...rest } = data;
    Object.assign(provider, rest, {
      updatedAt: new Date().toISOString()
    });
    this.write(state);
    return toPublicProvider(provider);
  }

  deleteProvider(id: string) {
    const state = this.all();
    state.providers = state.providers.filter((provider) => provider.id !== id);
    state.routes = state.routes.filter((route) => route.providerId !== id);
    this.write(state);
  }

  createRoute(input: unknown): ModelRoute {
    const data = routeSchema.parse(input);
    const state = this.all();
    ensureProvider(state, data.providerId);
    const now = new Date().toISOString();
    const route: ModelRoute = {
      id: nanoid(12),
      ...data,
      status: "unknown",
      createdAt: now,
      updatedAt: now
    };
    state.routes.push(route);
    this.write(state);
    return route;
  }

  updateRoute(id: string, input: unknown): ModelRoute {
    const data = routeSchema.partial().parse(input);
    const state = this.all();
    const route = state.routes.find((item) => item.id === id);
    if (!route) throw notFound("Route not found");
    if (data.providerId) ensureProvider(state, data.providerId);
    Object.assign(route, data, { updatedAt: new Date().toISOString() });
    this.write(state);
    return route;
  }

  deleteRoute(id: string) {
    const state = this.all();
    state.routes = state.routes.filter((route) => route.id !== id);
    this.write(state);
  }

  deleteModelAlias(alias: string) {
    const state = this.all();
    const before = state.routes.length;
    state.routes = state.routes.filter((route) => route.alias !== alias);
    state.modelSettings = state.modelSettings.filter((setting) => setting.alias !== alias);
    this.write(state);
    return { deleted: before - state.routes.length };
  }

  addApiKeys(providerId: string, input: unknown): PublicProvider {
    const schema = z.object({
      keys: z.string().min(1)
    });
    const data = schema.parse(input);
    const state = this.all();
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) throw notFound("Provider not found");

    const existing = new Set(provider.apiKeys.map((key) => key.value));
    const keys = data.keys
      .split(/[\n,，;；\s]+/)
      .map((key) => key.trim())
      .filter(Boolean)
      .filter((key) => !existing.has(key));

    for (const [index, key] of keys.entries()) {
      provider.apiKeys.push(createKey(`Key ${provider.apiKeys.length + index + 1}`, key));
      existing.add(key);
    }
    provider.updatedAt = new Date().toISOString();
    this.write(state);
    return toPublicProvider(provider);
  }

  deleteKey(providerId: string, keyId: string): PublicProvider {
    const state = this.all();
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) throw notFound("Provider not found");
    provider.apiKeys = provider.apiKeys.filter((key) => key.id !== keyId);
    const now = new Date().toISOString();
    for (const route of state.routes.filter((route) => route.providerId === providerId && route.keyId === keyId)) {
      route.enabled = false;
      route.status = "invalid";
      route.lastCheckedAt = now;
      route.lastFailedAt = now;
      route.failureSource = "sync";
      route.lastError = "绑定的 API Key 已删除";
      route.disabledReason = "绑定的 API Key 已删除，已移动到无法调用";
      route.updatedAt = now;
    }
    provider.updatedAt = new Date().toISOString();
    this.write(state);
    return toPublicProvider(provider);
  }

  updateKey(providerId: string, keyId: string, patch: { enabled?: boolean; label?: string }): PublicProvider {
    const state = this.all();
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) throw notFound("Provider not found");
    const key = provider.apiKeys.find((item) => item.id === keyId);
    if (!key) throw notFound("Key not found");
    if (patch.enabled !== undefined) key.enabled = patch.enabled;
    if (patch.label !== undefined) key.label = patch.label;
    provider.updatedAt = new Date().toISOString();
    this.write(state);
    return toPublicProvider(provider);
  }

  revealApiKeys(providerId: string) {
    const provider = this.all().providers.find((item) => item.id === providerId);
    if (!provider) throw notFound("Provider not found");
    return provider.apiKeys.map((key) => ({
      id: key.id,
      label: key.label,
      value: key.value,
      enabled: key.enabled,
      status: key.status,
      lastCheckedAt: key.lastCheckedAt,
      latencyMs: key.latencyMs,
      error: key.error,
      models: key.models
    }));
  }

  createClientKey(label: string, value?: string): ClientApiKey {
    const state = this.all();
    const now = new Date().toISOString();
    const key: ClientApiKey = {
      id: nanoid(12),
      label: label.trim() || "客户端 Key",
      value: value?.trim() || `sk-hub-${nanoid(32)}`,
      enabled: true,
      createdAt: now
    };
    state.settings.clientApiKeys.push(key);
    this.write(state);
    return key;
  }

  deleteClientKey(keyId: string) {
    const state = this.all();
    state.settings.clientApiKeys = state.settings.clientApiKeys.filter((key) => key.id !== keyId);
    this.write(state);
  }

  updateClientKey(keyId: string, patch: { enabled?: boolean; label?: string }): ClientApiKey {
    const state = this.all();
    const key = state.settings.clientApiKeys.find((item) => item.id === keyId);
    if (!key) throw notFound("Client key not found");
    if (patch.enabled !== undefined) key.enabled = patch.enabled;
    if (patch.label !== undefined) key.label = patch.label;
    this.write(state);
    return key;
  }

  revealClientKeys() {
    return this.all().settings.clientApiKeys;
  }

  findClientKey(value: string) {
    return this.all().settings.clientApiKeys.find((key) => key.value === value && key.enabled) ?? null;
  }

  markClientKeyUsed(keyId: string) {
    const state = this.all();
    const key = state.settings.clientApiKeys.find((item) => item.id === keyId);
    if (key) {
      key.lastUsedAt = new Date().toISOString();
      this.write(state);
    }
  }

  publicClientKeys() {
    return this.all().settings.clientApiKeys.map(({ value, ...key }) => ({
      ...key,
      preview: maskKey(value)
    }));
  }

  updateKeyStatus(providerId: string, keyId: string, patch: Partial<ApiKeyEntry>) {
    const state = this.all();
    const provider = state.providers.find((item) => item.id === providerId);
    const key = provider?.apiKeys.find((item) => item.id === keyId);
    if (!provider || !key) return;
    Object.assign(key, patch, { lastCheckedAt: new Date().toISOString() });
    provider.healthStatus = provider.apiKeys.some((item) => item.enabled && item.status === "healthy") ? "healthy" : patch.status ?? "unknown";
    provider.healthError = patch.error;
    provider.updatedAt = new Date().toISOString();
    this.write(state);
  }

  syncKeyModels(providerId: string, keyId: string, modelIds: string[], createRoutes: boolean, latencyMs?: number) {
    const state = this.all();
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) throw notFound("Provider not found");
    const key = provider.apiKeys.find((item) => item.id === keyId);
    if (!key) throw notFound("Key not found");

    const now = new Date().toISOString();
    const seen = new Set(modelIds);
    const existing = new Map(key.models.map((model) => [model.id, model]));
    const nextModels: SyncedModel[] = [];

    for (const id of modelIds) {
      const old = existing.get(id);
      nextModels.push({
        id,
        active: true,
        firstSeenAt: old?.firstSeenAt ?? now,
        lastSeenAt: now
      });
    }

    for (const old of key.models) {
      if (!seen.has(old.id)) {
        nextModels.push({ ...old, active: false });
      }
    }

    key.models = nextModels.sort((left, right) => left.id.localeCompare(right.id));
    provider.updatedAt = now;

    const autoDeleteInvalid = process.env.AUTO_DELETE_INVALID_ROUTES !== "false";
    const invalidRouteIds = new Set<string>();
    for (const route of state.routes.filter((route) => route.providerId === providerId)) {
      if (seen.has(route.upstreamModel)) {
        route.status = "valid";
        route.latencyMs = latencyMs;
        route.lastCheckedAt = now;
        route.disabledReason = undefined;
      } else {
        route.status = "invalid";
        route.latencyMs = latencyMs;
        route.lastCheckedAt = now;
        route.lastFailedAt = now;
        route.failureSource = "sync";
        route.lastError = "上游模型同步时未返回";
        route.enabled = false;
        route.disabledReason = autoDeleteInvalid ? "上游模型同步时未返回，已自动清理" : "上游模型同步时未返回，已自动停用";
        if (autoDeleteInvalid) invalidRouteIds.add(route.id);
      }
      route.updatedAt = now;
    }

    if (invalidRouteIds.size > 0) {
      state.routes = state.routes.filter((route) => !invalidRouteIds.has(route.id));
    }

    if (createRoutes) {
      const routeKeys = new Set(state.routes.map((route) => `${route.providerId}:${route.keyId ?? ""}:${route.upstreamModel}`));
      for (const id of modelIds) {
        const routeKey = `${providerId}:${keyId}:${id}`;
        if (!routeKeys.has(routeKey)) {
          state.routes.push({
            id: nanoid(12),
            alias: id,
            upstreamModel: id,
            providerId,
            keyId,
            enabled: true,
            status: "valid",
            latencyMs,
            lastCheckedAt: now,
            createdAt: now,
            updatedAt: now
          });
          routeKeys.add(routeKey);
        }
      }
    }

    this.write(state);
    return toPublicProvider(provider);
  }

  cleanupInvalidRoutes() {
    const state = this.all();
    const before = state.routes.length;
    state.routes = state.routes.filter((route) => route.status !== "invalid" && route.enabled);
    this.write(state);
    return { deleted: before - state.routes.length };
  }

  resolveModel(model: string) {
    return this.resolveCandidates(model).at(0) ?? null;
  }

  resolveCandidates(model: string) {
    const state = this.all();
    const now = Date.now();
    const setting = state.modelSettings.find((item) => item.alias === model);
    const routes = state.routes
      .filter((route) => {
        if (!route.enabled || route.status === "invalid") return false;
        if (route.disabledUntil && new Date(route.disabledUntil).getTime() > now) return false;
        return route.alias === model || route.upstreamModel === model;
      })
      .sort((left, right) => compareRoutes(setting?.strategy ?? "fixed", state, left, right, setting?.routeId));

    const candidates = [];
    for (const route of routes) {
      const provider = state.providers.find((item) => item.id === route.providerId);
      if (provider?.enabled) candidates.push({ provider, route });
    }

    if (candidates.length > 0) return candidates;

    const provider = state.providers
      .filter((item) => item.enabled)
      .sort((left, right) => left.priority - right.priority)
      .at(0);

    if (!provider) return [];
    return [{
      provider,
      route: {
        id: "direct",
        alias: model,
        upstreamModel: model,
        providerId: provider.id,
        keyId: undefined,
        enabled: true,
        createdAt: "",
        updatedAt: ""
      }
    }];
  }

  updateModelSetting(alias: string, strategy: ModelStrategy, routeId?: string, capabilities?: ProviderCapability[]) {
    const state = this.all();
    const now = new Date().toISOString();
    const existing = state.modelSettings.find((item) => item.alias === alias);
    const selectedRouteId = strategy === "fixed" ? normalizeSelectedRouteId(state, alias, routeId) : undefined;
    const nextCapabilities = capabilities ? normalizeCapabilities(capabilities) : undefined;
    if (existing) {
      existing.strategy = strategy;
      existing.routeId = selectedRouteId;
      if (nextCapabilities) existing.capabilities = nextCapabilities;
      existing.updatedAt = now;
    } else {
      state.modelSettings.push({ alias, strategy, routeId: selectedRouteId, capabilities: nextCapabilities, updatedAt: now });
    }
    this.write(state);
    return this.publicState();
  }

  updateSettings(input: unknown) {
    const schema = z.object({
      port: z.coerce.number().int().min(1024).max(65535).optional(),
      routeFailureThreshold: z.coerce.number().int().min(1).max(10).optional(),
      panelPassword: z.string().optional()
    });
    const data = schema.parse(input);
    const state = this.all();
    if (data.panelPassword !== undefined) {
      state.settings.panelPassword = data.panelPassword || undefined;
    }
    const { panelPassword: _pw, ...rest } = data;
    state.settings = { ...state.settings, ...rest };
    this.write(state);
    return this.publicState();
  }

  recordRouteResult(routeId: string, ok: boolean, latencyMs: number, error?: string, options: { failureSource?: RouteFailureSource; restoreOnSuccess?: boolean } = {}) {
    if (routeId === "direct") return;
    const state = this.all();
    const route = state.routes.find((item) => item.id === routeId);
    if (!route) return;
    route.latencyMs = latencyMs;
    route.lastCheckedAt = new Date().toISOString();
    route.updatedAt = route.lastCheckedAt;
    route.lastError = error;
    if (ok) {
      route.failureCount = 0;
      route.disabledUntil = undefined;
      route.status = "valid";
      route.disabledReason = undefined;
      route.lastError = undefined;
      route.lastFailedAt = undefined;
      route.failureSource = undefined;
      if (options.restoreOnSuccess) route.enabled = true;
    } else {
      route.failureCount = (route.failureCount ?? 0) + 1;
      route.lastFailedAt = route.lastCheckedAt;
      route.failureSource = options.failureSource ?? "chat";
      const threshold = Math.max(1, state.settings.routeFailureThreshold ?? 1);
      if (route.failureCount >= threshold) {
        route.enabled = false;
        route.status = "invalid";
        route.disabledUntil = undefined;
        route.disabledReason = `${failureSourceLabel(route.failureSource)}失败，已移动到无法调用`;
      }
    }
    this.write(state);
  }

  addLog(input: Omit<RequestLog, "id" | "createdAt">) {
    const state = this.all();
    state.logs.push({
      id: nanoid(10),
      createdAt: new Date().toISOString(),
      ...input
    });
    state.logs = state.logs.slice(-1000);
    this.write(state);
  }

  clearLogs() {
    const state = this.all();
    state.logs = [];
    this.write(state);
  }

  exportConfig(includeSecrets: boolean) {
    const state = this.all();
    if (includeSecrets) return state;
    return {
      ...state,
      providers: state.providers.map(toPublicProvider),
      logs: [],
      settings: {
        ...state.settings,
        clientApiKeys: state.settings.clientApiKeys.map(({ value, ...key }) => ({ ...key, value: "***" }))
      }
    };
  }

  importConfig(input: unknown) {
    const schema = z.object({
      providers: z.array(z.any()).default([]),
      routes: z.array(z.any()).default([]),
      logs: z.array(z.any()).optional().default([]),
      modelSettings: z.array(z.any()).optional().default([]),
      settings: z.any().optional()
    });
    const parsed = schema.parse(input);
    this.write(normalizeState(parsed as AppState));
    return this.publicState();
  }

  private write(state: AppState) {
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    const data = JSON.stringify(normalizeState(state), null, 2);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "w");
      fs.writeFileSync(fd, data, "utf8");
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath);
    }
    fs.renameSync(temporary, this.filePath);
    fs.copyFileSync(this.filePath, this.backupPath);
    this.cleanupTemporaryFiles();
  }

  private readStateFile(filePath: string): AppState {
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeState(JSON.parse(raw) as AppState);
  }

  private restoreBackup() {
    if (!fs.existsSync(this.backupPath)) return false;
    try {
      this.readStateFile(this.backupPath);
      fs.copyFileSync(this.backupPath, this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  private quarantineCorruptState() {
    if (!fs.existsSync(this.filePath)) return;
    const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(this.filePath, corruptPath);
    } catch {
      fs.copyFileSync(this.filePath, corruptPath);
    }
  }

  private cleanupTemporaryFiles() {
    const directory = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.`;
    for (const name of fs.readdirSync(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      try {
        fs.unlinkSync(path.join(directory, name));
      } catch {
        // Best effort cleanup; a concurrently running process may still own it.
      }
    }
  }
}

export function toPublicProvider(provider: Provider): PublicProvider {
  const { apiKeys, ...rest } = provider;
  delete (rest as unknown as { apiKey?: string }).apiKey;
  const allModelIds = new Set<string>();
  const publicKeys = apiKeys.map(({ value, ...key }) => {
    for (const m of key.models ?? []) allModelIds.add(m.id);
    return {
      ...key,
      preview: maskKey(value)
    };
  });
  return {
    ...rest,
    apiKeys: publicKeys,
    apiKeySet: apiKeys.length > 0,
    keyCount: apiKeys.length,
    healthyKeyCount: apiKeys.filter((key) => key.enabled && key.status === "healthy").length,
    modelCount: allModelIds.size
  };
}

export function notFound(message: string) {
  const error = new Error(message);
  Object.assign(error, { statusCode: 404 });
  return error;
}

function ensureProvider(state: AppState, providerId: string) {
  if (!state.providers.some((provider) => provider.id === providerId)) {
    throw notFound("Provider not found");
  }
}

function createKey(label: string, value: string): ApiKeyEntry {
  return {
    id: nanoid(10),
    label,
    value,
    enabled: true,
    status: "unknown",
    models: []
  };
}

function maskKey(value: string) {
  if (value.length <= 10) return "********";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

function normalizeState(state: AppState): AppState {
  const routes = (state.routes ?? []).map((route) => ({
    ...route,
    status: route.status ?? "unknown",
    failureCount: route.failureCount ?? 0,
    costTier: route.costTier ?? costTierFromRank((route as ModelRoute & { costRank?: number }).costRank)
  }));
  const aliases = new Set(routes.map((route) => route.alias));
  return {
    providers: (state.providers ?? []).map((provider) => {
      const legacy = provider as Provider & { apiKey?: string; models?: SyncedModel[] };
      const { apiKey: _apiKey, models: oldModels, ...rest } = legacy;
      const apiKeys = (provider.apiKeys ?? (legacy.apiKey ? [createKey("主 Key", legacy.apiKey)] : []))
        .filter((key) => typeof key.value === "string" && key.value.length > 0);
      if (oldModels && oldModels.length > 0 && apiKeys.length > 0 && (!apiKeys[0].models || apiKeys[0].models.length === 0)) {
        apiKeys[0].models = oldModels;
      }
      return {
        ...rest,
        apiKeys,
        healthStatus: provider.healthStatus ?? "unknown"
      };
    }),
    routes,
    logs: state.logs ?? [],
    modelSettings: (state.modelSettings ?? []).filter((setting) => aliases.has(setting.alias)).map((setting) => ({
      ...setting,
      capabilities: normalizeCapabilities(setting.capabilities)
    })),
    settings: {
      port: Number(state.settings?.port ?? 3127),
      routeFailureThreshold: Math.max(1, Number(state.settings?.routeFailureThreshold ?? 1)),
      clientApiKeys: (state.settings?.clientApiKeys ?? []).filter((key: ClientApiKey) => typeof key.value === "string" && key.value.length > 0),
      panelPassword: state.settings?.panelPassword ?? undefined
    }
  };
}

function normalizeCapabilities(capabilities?: ProviderCapability[]) {
  const values = capabilities?.filter((capability): capability is ProviderCapability => allCapabilities.includes(capability)) ?? [];
  return values.length > 0 ? [...new Set(values)] : [...defaultModelCapabilities];
}

function compareRoutes(strategy: ModelStrategy, state: AppState, left: ModelRoute, right: ModelRoute, routeId?: string) {
  const leftProvider = state.providers.find((provider) => provider.id === left.providerId);
  const rightProvider = state.providers.find((provider) => provider.id === right.providerId);
  if (strategy === "fixed") {
    if (routeId) {
      if (left.id === routeId && right.id !== routeId) return -1;
      if (right.id === routeId && left.id !== routeId) return 1;
    }
    const priorityDelta = (leftProvider?.priority ?? 999) - (rightProvider?.priority ?? 999);
    if (priorityDelta !== 0) return priorityDelta;
    const latencyDelta = (left.latencyMs ?? leftProvider?.latencyMs ?? Number.MAX_SAFE_INTEGER) - (right.latencyMs ?? rightProvider?.latencyMs ?? Number.MAX_SAFE_INTEGER);
    if (latencyDelta !== 0) return latencyDelta;
    return left.createdAt.localeCompare(right.createdAt);
  }
  if (strategy === "random") return Math.random() - 0.5;
  if (strategy === "cost") {
    const costDelta = costValue(left.costTier) - costValue(right.costTier);
    if (costDelta !== 0) return costDelta;
  }
  if (strategy === "priority") {
    const priorityDelta = (leftProvider?.priority ?? 999) - (rightProvider?.priority ?? 999);
    if (priorityDelta !== 0) return priorityDelta;
  }
  const latencyDelta = (left.latencyMs ?? leftProvider?.latencyMs ?? Number.MAX_SAFE_INTEGER) - (right.latencyMs ?? rightProvider?.latencyMs ?? Number.MAX_SAFE_INTEGER);
  if (latencyDelta !== 0) return latencyDelta;
  return (leftProvider?.priority ?? 999) - (rightProvider?.priority ?? 999);
}

function costValue(tier: ModelRoute["costTier"]) {
  if (tier === "low") return 0;
  if (tier === "high") return 2;
  return 1;
}

function costTierFromRank(rank?: number): ModelRoute["costTier"] {
  if (rank === undefined) return "medium";
  if (rank <= 33) return "low";
  if (rank >= 67) return "high";
  return "medium";
}

function failureSourceLabel(source?: RouteFailureSource) {
  if (source === "probe") return "检测";
  if (source === "sync") return "同步";
  if (source === "recover") return "恢复检测";
  return "请求";
}

function normalizeSelectedRouteId(state: AppState, alias: string, routeId?: string) {
  const activeRoutes = state.routes.filter((route) => route.alias === alias && route.enabled && route.status !== "invalid");
  if (routeId && activeRoutes.some((route) => route.id === routeId)) return routeId;
  return activeRoutes
    .sort((left, right) => compareRoutes("fixed", state, left, right))
    .at(0)?.id;
}
