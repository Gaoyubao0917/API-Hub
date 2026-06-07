import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Cable, CheckCircle2, FlaskConical, KeyRound, Plus, Power, RefreshCw, Route, Save, Trash2 } from "lucide-react";
import "./styles.css";

type Provider = {
  id: string;
  name: string;
  type: "openai-compatible" | "anthropic-compatible";
  baseUrl: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  notes: string;
  apiKeySet: boolean;
  apiKeys: PublicApiKey[];
  keyCount: number;
  healthyKeyCount: number;
  modelCount: number;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
  healthError?: string;
  latencyMs?: number;
  lastSyncedAt?: string;
};

type PublicApiKey = {
  id: string;
  label: string;
  enabled: boolean;
  status: "unknown" | "healthy" | "unhealthy";
  preview: string;
  lastCheckedAt?: string;
  latencyMs?: number;
  error?: string;
  models: { id: string; active: boolean; lastSeenAt: string }[];
};

type RevealedApiKey = Omit<PublicApiKey, "preview"> & {
  value: string;
};

type ModelRoute = {
  id: string;
  alias: string;
  upstreamModel: string;
  providerId: string;
  keyId?: string;
  enabled: boolean;
  status?: "unknown" | "valid" | "invalid";
  latencyMs?: number;
  lastCheckedAt?: string;
  failureCount?: number;
  disabledUntil?: string;
  disabledReason?: string;
  lastError?: string;
  lastFailedAt?: string;
  failureSource?: "chat" | "probe" | "sync" | "recover";
  costTier?: "low" | "medium" | "high";
  costNote?: string;
};

type ModelStrategy = "fixed" | "fastest" | "priority" | "cost" | "random";

type AppState = {
  providers: Provider[];
  routes: ModelRoute[];
  logs: RequestLog[];
  modelSettings: { alias: string; strategy: ModelStrategy; routeId?: string }[];
  settings: { port: number; routeFailureThreshold: number; clientKeyCount: number };
};

type RequestLog = {
  id: string;
  createdAt: string;
  model: string;
  providerName?: string;
  upstreamModel?: string;
  status: "success" | "failed" | "retried";
  statusCode?: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  error?: string;
};

type ProviderDraft = {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  notes: string;
};

type RouteDraft = {
  id?: string;
  alias: string;
  upstreamModel: string;
  providerId: string;
  enabled: boolean;
  costTier: "low" | "medium" | "high";
  costNote: string;
};

const defaultSections = ["dashboard", "aggregate", "management", "unavailable", "usage", "clientkeys", "diagnostics"];
const previewLimit = 5;
const emptyProvider: ProviderDraft = {
  name: "",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  enabled: true,
  priority: 50,
  timeoutMs: 60000,
  notes: ""
};
const emptyRoute: RouteDraft = {
  alias: "",
  upstreamModel: "",
  providerId: "",
  enabled: true,
  costTier: "medium",
  costNote: ""
};

function App() {
  const [state, setState] = useState<AppState>({ providers: [], routes: [], logs: [], modelSettings: [], settings: { port: 3127, routeFailureThreshold: 1, clientKeyCount: 0 } });
  const [diagnostics, setDiagnostics] = useState<{ level: string; message: string }[]>([]);
  const [hiddenDiagnostics, setHiddenDiagnostics] = useState<string[]>(() => readJson("api-hub-hidden-diagnostics", []));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readJson("api-hub-collapsed", {}));
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => normalizeSectionOrder(readJson("api-hub-section-order", defaultSections)));
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(emptyProvider);
  const [routeDraft, setRouteDraft] = useState<RouteDraft>(emptyRoute);
  const [portDraft, setPortDraft] = useState(3127);
  const [failureThresholdDraft, setFailureThresholdDraft] = useState(1);
  const [authRequired, setAuthRequired] = useState(false);
  const [panelPasswordEnabled, setPanelPasswordEnabled] = useState(false);
  const [adminTokenEnabled, setAdminTokenEnabled] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [adminTokenDraft, setAdminTokenDraft] = useState(() => getStoredAdminToken());
  const [loginError, setLoginError] = useState("");
  const [passwordChangeDraft, setPasswordChangeDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("准备就绪");
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [revealedKeys, setRevealedKeys] = useState<Record<string, RevealedApiKey[]>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [clientKeys, setClientKeys] = useState<{ id: string; label: string; enabled: boolean; preview: string; lastUsedAt?: string }[]>([]);
  const [revealClientKeys, setRevealClientKeys] = useState(false);
  const [clientKeyLabel, setClientKeyLabel] = useState("");
  const [clientKeyValue, setClientKeyValue] = useState("");
  const [selectedModels, setSelectedModels] = useState<Record<string, string[]>>({});
  const [groupTargets, setGroupTargets] = useState<Record<string, string>>({});
  const [newGroupTargets, setNewGroupTargets] = useState<Record<string, string>>({});
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({});
  const [showProviderForm, setShowProviderForm] = useState(state.providers.length === 0);
  const [expandedKeyPools, setExpandedKeyPools] = useState<Record<string, boolean>>(() => readJson("api-hub-expanded-key-pools", {}));
  const [expandedKeyManagers, setExpandedKeyManagers] = useState<Record<string, boolean>>({});
  const [showQuickRoute, setShowQuickRoute] = useState(false);
  const [favoriteModels, setFavoriteModels] = useState<string[]>(() => readJson("api-hub-favorite-models", []));
  const [hiddenModels, setHiddenModels] = useState<string[]>(() => readJson("api-hub-hidden-models", []));
  const [showHiddenModels, setShowHiddenModels] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const enabledProviders = state.providers.filter((provider) => provider.enabled).length;
  const enabledRoutes = state.routes.filter((route) => route.enabled).length;
  const activeRoutes = state.routes.filter((route) => route.enabled && route.status !== "invalid");
  const aggregateRoutes = state.routes.filter((route) => route.status !== "invalid");
  const unavailableRoutes = state.routes.filter((route) => route.status === "invalid");
  const aggregateModels = new Set(aggregateRoutes.map((route) => route.alias)).size;
  const fastestLatency = useMemo(() => {
    const latencies = state.routes.map((route) => route.latencyMs).filter((latency): latency is number => typeof latency === "number");
    return latencies.length ? `${Math.min(...latencies)}ms` : "待检测";
  }, [state.routes]);
  const successRate = useMemo(() => {
    if (state.logs.length === 0) return "待统计";
    return `${Math.round((state.logs.filter((log) => log.status === "success").length / state.logs.length) * 100)}%`;
  }, [state.logs]);
  const dashboardLogs = state.logs.slice(0, collapsed.dashboard ? previewLimit : 50);
  const dashboardTotalTokens = useMemo(() => state.logs.reduce((sum, log) => sum + (log.totalTokens ?? 0), 0), [state.logs]);
  const dashboardAvgLatency = useMemo(() => {
    if (state.logs.length === 0) return "待统计";
    return `${Math.round(state.logs.reduce((sum, log) => sum + log.latencyMs, 0) / state.logs.length)}ms`;
  }, [state.logs]);
  const failureReasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const log of state.logs) {
      if (log.status === "success") continue;
      const key = log.error || (log.statusCode ? `HTTP ${log.statusCode}` : "未知失败");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [state.logs]);
  const providerStats = useMemo(() => summarizeLogs(state.logs, (log) => log.providerName ?? "未知供应商"), [state.logs]);
  const modelStats = useMemo(() => summarizeLogs(state.logs, (log) => log.model), [state.logs]);
  const groupedRoutes = useMemo(() => {
    const groups = new Map<string, ModelRoute[]>();
    for (const route of aggregateRoutes) groups.set(route.alias, [...(groups.get(route.alias) ?? []), route]);
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [state.routes]);
  const unavailableGroups = useMemo(() => {
    const groups = new Map<string, ModelRoute[]>();
    for (const route of unavailableRoutes) groups.set(route.alias, [...(groups.get(route.alias) ?? []), route]);
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [state.routes]);
  const existingAliases = [...new Set(state.routes.map((route) => route.alias))].sort();
  const visibleDiagnostics = diagnostics.filter((issue) => !hiddenDiagnostics.includes(issue.message));

  async function load() {
    try {
      const authStatus = await request("/api/auth/status");
      setPanelPasswordEnabled(authStatus.panelPasswordEnabled);
      setAdminTokenEnabled(authStatus.adminTokenEnabled);
      if (!authStatus.authenticated) {
        setAuthRequired(true);
        return false;
      }
      setAuthRequired(false);
      const nextState = await request("/api/state");
      setState(nextState);
      setPortDraft(nextState.settings?.port ?? 3127);
      setFailureThresholdDraft(nextState.settings?.routeFailureThreshold ?? 1);
      if (nextState.providers.length > 0) setShowProviderForm(false);
      const diag = await request("/api/diagnostics");
      setDiagnostics(diag.issues ?? []);
      return true;
    } catch (error) {
      if (isUnauthorized(error)) {
        setAuthRequired(true);
        return false;
      }
      throw error;
    }
  }

  useEffect(() => {
    load().catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    if (!authRequired) loadClientKeys().catch(() => {});
  }, [authRequired, revealClientKeys]);

  async function saveProvider(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { ...providerDraft, type: "openai-compatible", apiKey: providerDraft.apiKey };
      if (providerDraft.id && providerDraft.apiKey.trim() === "") delete payload.apiKey;
      await request(providerDraft.id ? `/api/providers/${providerDraft.id}` : "/api/providers", {
        method: providerDraft.id ? "PUT" : "POST",
        body: JSON.stringify(payload)
      });
      setProviderDraft(emptyProvider);
      setStatus("供应商已保存");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveRoute(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await request(routeDraft.id ? `/api/routes/${routeDraft.id}` : "/api/routes", {
        method: routeDraft.id ? "PUT" : "POST",
        body: JSON.stringify(routeDraft)
      });
      setRouteDraft(emptyRoute);
      setStatus("模型路由已保存");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(path: string) {
    await request(path, { method: "DELETE" });
    setStatus("已删除");
    await load();
  }

  async function testProvider(provider: Provider) {
    setTestResults((current) => ({ ...current, [provider.id]: "测试中..." }));
    try {
      const result = await request(`/api/providers/${provider.id}/test`, { method: "POST" });
      setTestResults((current) => ({ ...current, [provider.id]: `${result.ok ? "可用" : "异常"} · HTTP ${result.status} · ${result.latencyMs}ms` }));
      await load();
    } catch (error) {
      setTestResults((current) => ({ ...current, [provider.id]: error instanceof Error ? error.message : "测试失败" }));
    }
  }

  async function toggleRevealKeys(provider: Provider) {
    if (revealedKeys[provider.id]) {
      setRevealedKeys((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
      return;
    }
    const result = await request(`/api/providers/${provider.id}/keys`);
    setRevealedKeys((current) => ({ ...current, [provider.id]: result.keys ?? [] }));
  }

  async function addProviderKeys(provider: Provider) {
    const keys = (keyDrafts[provider.id] ?? "").trim();
    if (!keys) {
      setStatus("请输入要添加的 API Key");
      return;
    }
    await request(`/api/providers/${provider.id}/keys`, {
      method: "POST",
      body: JSON.stringify({ keys })
    });
    setKeyDrafts((current) => ({ ...current, [provider.id]: "" }));
    setRevealedKeys((current) => {
      const next = { ...current };
      delete next[provider.id];
      return next;
    });
    setStatus(`已为 ${provider.name} 添加 API Key`);
    await load();
  }

  async function syncModels(provider: Provider) {
    setStatus(`正在同步 ${provider.name}`);
    const result = await request(`/api/providers/${provider.id}/sync-models`, { method: "POST", body: JSON.stringify({ createRoutes: false }) });
    setStatus(`已同步 ${result.modelCount} 个模型，请在模型池中勾选后加入路由`);
    await load();
  }

  async function syncAllProviders() {
    setBusy(true);
    setStatus("正在同步全部供应商...");
    try {
      const result = await request("/api/providers/sync-all", { method: "POST" });
      const errors = result.results.filter((r: { error?: string }) => r.error);
      setStatus(`同步完成：${result.synced} 个供应商${errors.length ? `，${errors.length} 个失败` : ""}`);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "批量同步失败");
    } finally {
      setBusy(false);
    }
  }

  async function runRepair() {
    setBusy(true);
    setStatus("正在执行一键修复...");
    try {
      const result = await request("/api/repair/run", { method: "POST" });
      setStatus(`修复完成：同步 ${result.synced} 个供应商，恢复 ${result.recovered} 条候选`);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "一键修复失败");
    } finally {
      setBusy(false);
    }
  }

  function toggleKeyPool(keyId: string) {
    setExpandedKeyPools((current) => {
      const next = { ...current, [keyId]: !current[keyId] };
      localStorage.setItem("api-hub-expanded-key-pools", JSON.stringify(next));
      return next;
    });
  }

  function toggleKeyManager(providerId: string) {
    setExpandedKeyManagers((current) => ({ ...current, [providerId]: !current[providerId] }));
  }

  function toggleKeySelection(providerId: string, keyId: string, modelId: string) {
    const selKey = `${providerId}:${keyId}`;
    setSelectedModels((current) => {
      const selected = new Set(current[selKey] ?? []);
      if (selected.has(modelId)) selected.delete(modelId);
      else selected.add(modelId);
      return { ...current, [selKey]: [...selected] };
    });
  }

  function toggleFavoriteModel(modelId: string) {
    setFavoriteModels((current) => {
      const next = current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId];
      localStorage.setItem("api-hub-favorite-models", JSON.stringify(next));
      return next;
    });
  }

  function toggleHiddenModel(modelId: string) {
    setHiddenModels((current) => {
      const next = current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId];
      localStorage.setItem("api-hub-hidden-models", JSON.stringify(next));
      return next;
    });
  }

  function visibleKeyModels(key: PublicApiKey, providerId: string) {
    const selKey = `${providerId}:${key.id}`;
    const query = (modelSearch[selKey] ?? "").trim().toLowerCase();
    return (key.models ?? [])
      .filter((model) => model.active)
      .filter((model) => !hiddenModels.includes(model.id) || showHiddenModels)
      .filter((model) => !query || model.id.toLowerCase().includes(query))
      .sort((a, b) => {
        const af = favoriteModels.includes(a.id) ? 0 : 1;
        const bf = favoriteModels.includes(b.id) ? 0 : 1;
        return af - bf || a.id.localeCompare(b.id);
      })
      .slice(0, 200);
  }

  function groupedKeyModels(key: PublicApiKey, providerId: string) {
    const groups = new Map<string, { id: string; active: boolean; lastSeenAt: string }[]>();
    for (const model of visibleKeyModels(key, providerId)) {
      const category = modelCategory(model.id);
      groups.set(category, [...(groups.get(category) ?? []), model]);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }

  function modelCategory(modelId: string) {
    const id = modelId.toLowerCase();
    if (id.includes("deepseek")) return "DeepSeek";
    if (id.includes("claude")) return "Claude";
    if (id.includes("gpt") || id.includes("o1-") || id.includes("o3-") || id.includes("o4-") || id.includes("davinci") || id.includes("text-embedding")) return "OpenAI";
    if (id.includes("gemini")) return "Gemini";
    if (id.includes("qwen")) return "通义千问";
    if (id.includes("llama") || id.includes("meta-")) return "Llama";
    if (id.includes("minimax") || id.includes("abab")) return "MiniMax";
    if (id.includes("glm") || id.includes("chatglm")) return "ChatGLM";
    if (id.startsWith("yi-") || id.includes("yi-")) return "Yi";
    if (id.includes("moonshot") || id.includes("kimi")) return "Kimi";
    if (id.includes("doubao") || id.includes("skylark")) return "豆包";
    if (id.includes("ernie") || id.includes("wenxin")) return "文心";
    if (id.includes("hunyuan")) return "混元";
    if (id.includes("mistral") || id.includes("codestral") || id.includes("mixtral")) return "Mistral";
    if (id.includes("command") || id.includes("cohere")) return "Cohere";
    if (id.includes("grok")) return "Grok";
    if (id.includes("step-")) return "Step";
    return "其他";
  }

  async function syncProviderKey(provider: Provider, keyId: string) {
    setStatus(`正在同步 ${provider.name} / ${keyId.slice(0, 8)}...`);
    await request(`/api/providers/${provider.id}/keys/${keyId}/sync`, { method: "POST", body: JSON.stringify({ createRoutes: false }) });
    setStatus(`同步完成`);
    await load();
  }

  async function toggleRouteEnabled(route: ModelRoute) {
    await request(`/api/routes/${route.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !route.enabled })
    });
    setStatus(`路由 ${route.alias} 已${route.enabled ? "停用" : "启用"}`);
    await load();
  }

  function selectVisibleKeyModels(providerId: string, keyId: string) {
    const key = state.providers.find((p) => p.id === providerId)?.apiKeys.find((k) => k.id === keyId);
    if (!key) return;
    const selKey = `${providerId}:${keyId}`;
    const ids = visibleKeyModels(key, providerId).map((model) => model.id);
    setSelectedModels((current) => ({ ...current, [selKey]: ids }));
  }

  function selectCategoryKeyModels(providerId: string, keyId: string, category: string) {
    const key = state.providers.find((p) => p.id === providerId)?.apiKeys.find((k) => k.id === keyId);
    if (!key) return;
    const selKey = `${providerId}:${keyId}`;
    const ids = visibleKeyModels(key, providerId).filter((model) => modelCategory(model.id) === category).map((model) => model.id);
    setSelectedModels((current) => ({ ...current, [selKey]: [...new Set([...(current[selKey] ?? []), ...ids])] }));
  }

  function clearKeySelectedModels(providerId: string, keyId: string) {
    setSelectedModels((current) => ({ ...current, [`${providerId}:${keyId}`]: [] }));
  }

  async function addSelectedKeyModels(provider: Provider, key: PublicApiKey, aliasOverride?: string) {
    const selKey = `${provider.id}:${key.id}`;
    const selected = selectedModels[selKey] ?? [];
    if (selected.length === 0) {
      setStatus("请先勾选模型");
      return;
    }
    const existing = new Set(state.routes.map((route) => `${route.providerId}:${route.keyId ?? ""}:${route.upstreamModel}:${route.alias}`));
    let added = 0;
    for (const modelId of selected) {
      const alias = aliasOverride || modelId;
      if (existing.has(`${provider.id}:${key.id}:${modelId}:${alias}`)) continue;
      await request("/api/routes", {
        method: "POST",
        body: JSON.stringify({ alias, upstreamModel: modelId, providerId: provider.id, keyId: key.id, enabled: true, costTier: "medium", costNote: "" })
      });
      added += 1;
    }
    setSelectedModels((current) => ({ ...current, [selKey]: [] }));
    setStatus(aliasOverride ? `已加入分组 ${aliasOverride}：${added} 个` : `已加入模型路由：${added} 个`);
    await load();
  }

  async function addSelectedToNewGroup(provider: Provider, key: PublicApiKey) {
    const selKey = `${provider.id}:${key.id}`;
    const alias = (newGroupTargets[selKey] ?? "").trim();
    if (!alias) { setStatus("请输入新分组名称"); return; }
    if (existingAliases.includes(alias)) { setStatus(`分组 ${alias} 已存在，请使用加入已有分组`); return; }
    await addSelectedKeyModels(provider, key, alias);
    setNewGroupTargets((current) => ({ ...current, [selKey]: "" }));
  }

  async function cleanupInvalidRoutes() {
    const result = await request("/api/routes/cleanup-invalid", { method: "POST" });
    setStatus(`已删除 ${result.deleted} 条无效模型`);
    await load();
  }

  async function exportConfig(includeSecrets: boolean) {
    const response = await fetch(`/api/config/export?includeSecrets=${includeSecrets}`, { credentials: "include" });
    if (!response.ok) {
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = includeSecrets ? "api-hub-config-full.json" : "api-hub-config-safe.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function loginWithPassword(event: React.FormEvent) {
    event.preventDefault();
    setLoginError("");
    try {
      if (adminTokenEnabled && !panelPasswordEnabled) {
        const token = adminTokenDraft.trim();
        if (!token) {
          setLoginError("请输入管理令牌");
          return;
        }
        localStorage.setItem("api-hub-admin-token", token);
        const ok = await load();
        if (!ok) {
          localStorage.removeItem("api-hub-admin-token");
          setLoginError("管理令牌无效");
        }
        return;
      }
      await request("/api/auth/login", { method: "POST", body: JSON.stringify({ password: passwordDraft }) });
      setPasswordDraft("");
      setStatus("登录成功");
      await load();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    }
  }

  async function logout() {
    localStorage.removeItem("api-hub-admin-token");
    setAdminTokenDraft("");
    await request("/api/auth/logout", { method: "POST" });
    setAuthRequired(true);
    setStatus("已退出登录");
  }

  async function loadClientKeys() {
    const endpoint = revealClientKeys ? "/api/client-keys/reveal" : "/api/client-keys";
    const result = await request(endpoint);
    setClientKeys(result.keys ?? []);
  }

  async function createClientKey() {
    const value = clientKeyValue.trim() || undefined;
    const result = await request("/api/client-keys", { method: "POST", body: JSON.stringify({ label: clientKeyLabel, value }) });
    setClientKeyLabel("");
    setClientKeyValue("");
    setStatus(`客户端 Key 已创建：${result.value}`);
    await loadClientKeys();
    await load();
  }

  async function toggleClientKey(keyId: string, enabled: boolean) {
    await request(`/api/client-keys/${keyId}`, { method: "PATCH", body: JSON.stringify({ enabled: !enabled }) });
    await loadClientKeys();
  }

  async function deleteClientKey(keyId: string) {
    await request(`/api/client-keys/${keyId}`, { method: "DELETE" });
    await loadClientKeys();
    await load();
  }

  async function importConfig(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await request("/api/config/import", { method: "POST", body: await file.text() });
    event.target.value = "";
    setStatus("配置已导入");
    await load();
  }

  async function clearLogs() {
    await request("/api/logs", { method: "DELETE" });
    setStatus("调用看板已清空");
    await load();
  }

  async function updateStrategy(alias: string, strategy: ModelStrategy, routeId?: string) {
    await request(`/api/model-settings/${encodeURIComponent(alias)}`, { method: "PUT", body: JSON.stringify({ strategy, routeId }) });
    setStatus(`模型 ${alias} 策略已更新`);
    await load();
  }

  async function probeRoute(route: ModelRoute) {
    setStatus(`正在检测 ${route.alias} / ${route.upstreamModel}`);
    const result = await request(`/api/routes/${route.id}/probe`, { method: "POST" });
    setStatus(`检测完成：HTTP ${result.status} · ${result.latencyMs}ms`);
    await load();
  }

  async function recoverRoute(route: ModelRoute) {
    setStatus(`正在恢复检测 ${route.alias} / ${route.upstreamModel}`);
    const result = await request(`/api/routes/${route.id}/recover`, { method: "POST" });
    if (result.ok) {
      setStatus(`恢复成功：${route.alias} / ${route.upstreamModel} 已重新启用`);
    } else {
      setStatus(`恢复失败：${result.error ?? `HTTP ${result.status}`}`);
    }
    await load();
  }

  async function probeAlias(alias: string) {
    setStatus(`正在检测聚合模型 ${alias}`);
    const result = await request(`/api/models/${encodeURIComponent(alias)}/probe`, { method: "POST" });
    const ok = result.results.filter((item: { ok: boolean }) => item.ok).length;
    setStatus(`聚合模型 ${alias} 检测完成：${ok}/${result.count} 可用`);
    await load();
  }

  async function savePort() {
    const payload: Record<string, unknown> = { port: portDraft, routeFailureThreshold: failureThresholdDraft };
    if (passwordChangeDraft.trim()) {
      payload.panelPassword = passwordChangeDraft.trim();
    }
    const result = await request("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
    setPasswordChangeDraft("");
    setStatus(`设置已保存：端口 ${result.settings.port}，连续失败 ${result.settings.routeFailureThreshold} 次禁用${payload.panelPassword ? "，密码已更新" : ""}。端口重启后生效`);
    await load();
  }

  function toggleSection(key: string) {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    localStorage.setItem("api-hub-collapsed", JSON.stringify(next));
  }

  function moveSection(key: string, direction: -1 | 1) {
    const current = sectionOrder.includes(key) ? sectionOrder : defaultSections;
    const index = current.indexOf(key);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return;
    const next = [...current];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setSectionOrder(next);
    localStorage.setItem("api-hub-section-order", JSON.stringify(next));
  }

  function sectionControls(key: string) {
    return (
      <div className="sectionControls">
        <button title="上移" onClick={() => moveSection(key, -1)}>↑</button>
        <button title="下移" onClick={() => moveSection(key, 1)}>↓</button>
        <button onClick={() => toggleSection(key)}>{collapsed[key] ? "展开" : "收起"}</button>
      </div>
    );
  }

  function sectionStyle(key: string) {
    return { order: sectionOrder.indexOf(key) >= 0 ? sectionOrder.indexOf(key) : 99 };
  }

  function hideDiagnostic(message: string) {
    const next = [...new Set([...hiddenDiagnostics, message])];
    setHiddenDiagnostics(next);
    localStorage.setItem("api-hub-hidden-diagnostics", JSON.stringify(next));
  }

  function clearDiagnostics() {
    const next = diagnostics.map((issue) => issue.message);
    setHiddenDiagnostics(next);
    localStorage.setItem("api-hub-hidden-diagnostics", JSON.stringify(next));
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="titleLine">
            <h1>API Hub</h1>
          </div>
          <p>多中转站模型聚合、测速择优、失效清理</p>
        </div>
        <div className="proxyBox">
          <span>OpenAI Base URL</span>
          <code>http://127.0.0.1:{state.settings.port}/v1</code>
        </div>
      </header>

      {authRequired && (
        <section className="panel authPanel">
          <div className="sectionTitle">
            <h2>面板登录</h2>
            <span>{adminTokenEnabled && !panelPasswordEnabled ? "请输入管理令牌" : "请输入面板密码"}</span>
          </div>
          <form className="authForm" onSubmit={loginWithPassword}>
            {adminTokenEnabled && !panelPasswordEnabled ? (
              <label>管理令牌<input value={adminTokenDraft} onChange={(event) => { setAdminTokenDraft(event.target.value); setLoginError(""); }} type="password" autoFocus /></label>
            ) : (
              <label>密码<input value={passwordDraft} onChange={(event) => { setPasswordDraft(event.target.value); setLoginError(""); }} type="password" autoFocus /></label>
            )}
            <button className="primary"><KeyRound size={16} />登录</button>
          </form>
          {loginError && <small className="loginError">{loginError}</small>}
        </section>
      )}

      {!authRequired && (
      <>
      <section className="panel dashboardPanel" style={sectionStyle("dashboard")}>
        <div className="sectionTitle">
          <h2>调用看板</h2>
          <div className="titleActions">
            <span>最近 {dashboardLogs.length} 条链路</span>
            <button className="iconButton" onClick={clearLogs}><Trash2 size={18} /></button>
            {sectionControls("dashboard")}
          </div>
        </div>
        <div className="dashboardSummary">
          <div><span>请求总数</span><strong>{state.logs.length}</strong></div>
          <div><span>成功率</span><strong>{successRate}</strong></div>
          <div><span>平均延迟</span><strong>{dashboardAvgLatency}</strong></div>
          <div><span>总 Token</span><strong>{dashboardTotalTokens || "未返回"}</strong></div>
        </div>
        {!collapsed.dashboard && (
          <div className="dashboardInsights">
            <div><span>供应商概览</span>{providerStats.length === 0 ? <small>暂无数据</small> : providerStats.map((item) => <small key={item.name}>{item.name} · {item.count} 次 · 成功 {item.successRate}% · 均 {item.avgLatency}ms</small>)}</div>
            <div><span>模型概览</span>{modelStats.length === 0 ? <small>暂无数据</small> : modelStats.map((item) => <small key={item.name}>{item.name} · {item.count} 次 · 成功 {item.successRate}% · 均 {item.avgLatency}ms</small>)}</div>
            <div><span>失败原因 Top</span>{failureReasons.length === 0 ? <small>暂无失败</small> : failureReasons.map(([reason, count]) => <small key={reason}>{reason} · {count} 次</small>)}</div>
          </div>
        )}
        <div className="flowBoard">
          {dashboardLogs.length === 0 ? <small>暂无调用记录</small> : dashboardLogs.map((log) => <FlowCard log={log} key={log.id} />)}
        </div>
      </section>

      <section className="opsBar">
        <div><KeyRound size={18} /><span>聚合模型</span><strong>{aggregateModels}</strong></div>
        <div><RefreshCw size={18} /><span>候选路由</span><strong>{enabledRoutes}</strong></div>
        <div><Activity size={18} /><span>最快延迟</span><strong>{fastestLatency}</strong></div>
        <button onClick={syncAllProviders} disabled={busy}><RefreshCw size={17} />同步全部</button>
        <button onClick={runRepair} disabled={busy}><CheckCircle2 size={17} />一键修复</button>
        <button onClick={cleanupInvalidRoutes}><Trash2 size={17} />清理无效</button>
        <button onClick={() => exportConfig(false)}><Save size={17} />导出脱敏</button>
        <button onClick={() => exportConfig(true)}><Save size={17} />导出完整</button>
        <button onClick={() => importInputRef.current?.click()}><Plus size={17} />导入配置</button>
        {panelPasswordEnabled && <button onClick={logout}><KeyRound size={17} />退出登录</button>}
        <div className="portEditor">
          <input value={portDraft} onChange={(event) => setPortDraft(Number(event.target.value))} type="number" min={1024} max={65535} placeholder="端口" />
          <input value={failureThresholdDraft} onChange={(event) => setFailureThresholdDraft(Number(event.target.value))} type="number" min={1} max={10} title="连续失败几次后禁用候选" placeholder="阈值" />
          <input value={passwordChangeDraft} onChange={(event) => setPasswordChangeDraft(event.target.value)} type="password" placeholder="新面板密码（留空不改）" />
          <button onClick={savePort}>保存设置</button>
        </div>
        <input ref={importInputRef} className="hiddenInput" type="file" accept="application/json,.json" onChange={importConfig} />
      </section>

      <section className="panel aggregatePanel" style={sectionStyle("aggregate")}>
        <div className="sectionTitle">
          <h2>聚合模型</h2>
          <div className="titleActions"><span>{groupedRoutes.length} 个对外模型</span>{sectionControls("aggregate")}</div>
        </div>
        <div className={`aggregateGrid ${collapsed.aggregate ? "previewGrid" : ""}`}>
          {groupedRoutes.slice(0, collapsed.aggregate ? previewLimit : groupedRoutes.length).map(([alias, routes]) => {
            const measuredRoutes = routes.filter((r) => typeof r.latencyMs === "number" && r.latencyMs > 0);
            const avgLatency = measuredRoutes.length > 0 ? Math.round(measuredRoutes.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / measuredRoutes.length) : null;
            const bestLatency = measuredRoutes.length > 0 ? Math.min(...measuredRoutes.map((r) => r.latencyMs ?? 0)) : null;
            const enabledCount = routes.filter((r) => r.enabled).length;
            const healthyCount = routes.filter((r) => r.enabled && r.status === "valid").length;
            const setting = state.modelSettings.find((item) => item.alias === alias);
            const strategy = setting?.strategy ?? "fixed";
            const enabledCandidates = routes.filter((route) => route.enabled);
            const selectedRouteId = setting?.routeId && enabledCandidates.some((route) => route.id === setting.routeId) ? setting.routeId : enabledCandidates[0]?.id ?? "";
            return (
            <article className="aggregateItem" key={alias}>
              <div>
                <strong>{alias}</strong>
                <div className="aggregateActions">
                  <small>{routes.length} 候选 · {enabledCount} 启用 · {healthyCount} 正常{avgLatency !== null ? ` · 均${avgLatency}ms · 快${bestLatency}ms` : ""}</small>
                  <button onClick={() => probeAlias(alias)}>检测全部</button>
                </div>
              </div>
              <select value={strategy} onChange={(event) => updateStrategy(alias, event.target.value as ModelStrategy, selectedRouteId)}>
                <option value="fixed">指定候选</option>
                <option value="fastest">最快优先</option>
                <option value="priority">供应商优先级</option>
                <option value="cost">成本优先</option>
                <option value="random">随机分流</option>
              </select>
              {strategy === "fixed" && (
                <select value={selectedRouteId} onChange={(event) => updateStrategy(alias, "fixed", event.target.value)} disabled={enabledCandidates.length === 0}>
                  {enabledCandidates.map((route) => {
                    const provider = state.providers.find((item) => item.id === route.providerId);
                    const keyLabel = provider?.apiKeys.find((key) => key.id === route.keyId)?.label;
                    return <option key={route.id} value={route.id}>{provider?.name ?? "未知供应商"}{keyLabel ? ` / ${keyLabel}` : ""} / {route.upstreamModel}</option>;
                  })}
                </select>
              )}
              <div className="candidateList">
                {routes.sort((left, right) => (left.latencyMs ?? Number.MAX_SAFE_INTEGER) - (right.latencyMs ?? Number.MAX_SAFE_INTEGER)).map((route) => {
                  const provider = state.providers.find((item) => item.id === route.providerId);
                  const keyLabel = provider?.apiKeys.find((key) => key.id === route.keyId)?.label;
                  return (
                    <small className={route.enabled ? "" : "disabledCandidate"} key={route.id}>
                      <span>{provider?.name ?? "未知供应商"}{keyLabel ? ` / ${keyLabel}` : ""} / {route.upstreamModel} · {route.latencyMs ? `${route.latencyMs}ms` : "待测"} · 成本 {costTierLabel(route.costTier)} · {route.enabled ? "启用" : "停用"} · {route.status ?? "unknown"}</span>
                      <span className="candidateActions">
                        <button onClick={() => toggleRouteEnabled(route)}>{route.enabled ? "停用" : "启用"}</button>
                        <button onClick={() => probeRoute(route)}>Probe</button>
                      </span>
                    </small>
                  );
                })}
              </div>
            </article>
            );
          })}
        </div>
      </section>

      <section className="panel" style={sectionStyle("management")}>
        <div className="sectionTitle">
          <h2>供应商与路由</h2>
          <div className="titleActions">
            <span>{state.routes.length} 条路由</span>
            <button className="iconButton" title="刷新" onClick={load}><RefreshCw size={16} /></button>
            <button className="iconButton" onClick={cleanupInvalidRoutes}><CheckCircle2 size={16} /></button>
            <button className="compactPrimary" onClick={() => { setProviderDraft(emptyProvider); setShowProviderForm(!showProviderForm); }}>
              {showProviderForm ? "收起" : "添加供应商"}
            </button>
            {sectionControls("management")}
          </div>
        </div>
        {collapsed.management && (
          <div className="list previewList">
            {state.providers.length === 0 ? <small>暂无供应商</small> : state.providers.slice(0, previewLimit).map((provider) => {
              const providerRoutes = state.routes.filter((route) => route.providerId === provider.id);
              return (
                <article className="item" key={provider.id}>
                  <div>
                    <strong>{provider.name}</strong>
                    <span>{provider.baseUrl}</span>
                    <small>{provider.modelCount} 个模型 · {providerRoutes.length} 条路由 · {provider.enabled ? "启用" : "停用"} · 优先级 {provider.priority}</small>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {!collapsed.management && (
        <>
        {showProviderForm && (
          <form className="form" onSubmit={(e) => { saveProvider(e); }}>
            <label>名称<input value={providerDraft.name} onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })} required /></label>
            <label>Base URL<input value={providerDraft.baseUrl} onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} required /></label>
            <label>API Key<input value={providerDraft.apiKey} onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })} type="password" placeholder={providerDraft.id ? "留空保持原 Key" : "sk-..."} /></label>
            <div className="inline">
              <label>优先级<input value={providerDraft.priority} onChange={(event) => setProviderDraft({ ...providerDraft, priority: Number(event.target.value) })} type="number" min={0} /></label>
              <label>超时 ms<input value={providerDraft.timeoutMs} onChange={(event) => setProviderDraft({ ...providerDraft, timeoutMs: Number(event.target.value) })} type="number" min={1000} /></label>
            </div>
            <label>备注<textarea value={providerDraft.notes} onChange={(event) => setProviderDraft({ ...providerDraft, notes: event.target.value })} rows={2} /></label>
            <label className="check"><input checked={providerDraft.enabled} onChange={(event) => setProviderDraft({ ...providerDraft, enabled: event.target.checked })} type="checkbox" />启用</label>
            <button className="primary" disabled={busy}>{providerDraft.id ? <Save size={16} /> : <Plus size={16} />}{providerDraft.id ? "保存供应商" : "添加供应商"}</button>
          </form>
        )}
        <div className="list">
          {state.providers.map((provider) => {
            const providerRoutes = state.routes.filter((route) => route.providerId === provider.id);
            return (
              <article className="item" key={provider.id}>
                <div>
                  <div className="providerHeader">
                    <span className={`healthDot ${provider.healthStatus ?? "unknown"}`} title={provider.healthStatus === "healthy" ? "正常" : provider.healthStatus === "unhealthy" ? "异常" : "未知"} />
                    <strong>{provider.name}</strong>
                    <div className="actions">
                      <button title="编辑" onClick={async () => {
                        let firstKey = "";
                        try {
                          const result = await request(`/api/providers/${provider.id}/keys`);
                          firstKey = result.keys?.[0]?.value ?? "";
                        } catch {}
                        setProviderDraft({ ...provider, apiKey: firstKey });
                        setShowProviderForm(true);
                      }}><KeyRound size={14} /></button>
                      <button title="测试" onClick={() => testProvider(provider)}><FlaskConical size={14} /></button>
                      <button title="同步模型" onClick={() => syncModels(provider)}><RefreshCw size={14} /></button>
                      <button title={expandedKeyManagers[provider.id] ? "收起" : "展开"} onClick={() => toggleKeyManager(provider.id)}>{expandedKeyManagers[provider.id] ? "▲" : "▼"}</button>
                      <button title="删除" onClick={() => remove(`/api/providers/${provider.id}`)}><Trash2 size={14} /></button>
                    </div>
                  </div>
                  <span>{provider.baseUrl}</span>
                  <small>
                    {provider.modelCount} 个模型 · {providerRoutes.length} 条路由 · 延迟 {provider.latencyMs ? `${provider.latencyMs}ms` : "-"} · 优先级 {provider.priority}
                  </small>
                  {testResults[provider.id] && <small>{testResults[provider.id]}</small>}
                  {expandedKeyManagers[provider.id] && (
                  <>
                  <div className="keyManager">
                    <div className="keyManagerHeader">
                      <span>API Key · {provider.keyCount} 个 · {provider.healthyKeyCount} 个健康</span>
                      <button onClick={() => toggleRevealKeys(provider)} disabled={provider.keyCount === 0}>{revealedKeys[provider.id] ? "隐藏明码" : "显示明码"}</button>
                    </div>
                    <div className="keyPreviewList">
                      {provider.apiKeys.length === 0 ? <small>暂无 API Key</small> : provider.apiKeys.map((key) => {
                        const revealed = revealedKeys[provider.id]?.find((item) => item.id === key.id);
                        return (
                          <small className={`keyPreviewItem ${key.enabled ? key.status : "disabled"}`} key={key.id}>
                            <span className={`keyStatusDot ${key.enabled ? key.status : "disabled"}`} />
                            <span>{key.label} · {revealed?.value ?? key.preview}</span>
                            <span className="keyActions">
                              <button title={key.enabled ? "停用" : "启用"} className="keyToggle" onClick={async () => {
                                await request(`/api/providers/${provider.id}/keys/${key.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !key.enabled }) });
                                setRevealedKeys((current) => {
                                  const next = { ...current };
                                  delete next[provider.id];
                                  return next;
                                });
                                await load();
                              }}><Power size={12} /></button>
                              <button title="删除" className="keyDelete" onClick={async () => {
                                await request(`/api/providers/${provider.id}/keys/${key.id}`, { method: "DELETE" });
                                setRevealedKeys((current) => {
                                  const next = { ...current };
                                  delete next[provider.id];
                                  return next;
                                });
                                await load();
                              }}><Trash2 size={12} /></button>
                            </span>
                          </small>
                        );
                      })}
                    </div>
                    <div className="bulkKeys">
                      <textarea value={keyDrafts[provider.id] ?? ""} onChange={(event) => setKeyDrafts((current) => ({ ...current, [provider.id]: event.target.value }))} rows={2} placeholder="批量添加 API Key，可用换行、逗号、空格分隔" />
                      <button title="批量添加 Key" onClick={() => addProviderKeys(provider)}><Plus size={16} /></button>
                    </div>
                    <div className="keyModelPools">
                      {provider.apiKeys.map((key) => {
                        const isPoolExpanded = expandedKeyPools[key.id] === true;
                        return (
                          <div className="keyModelPoolItem" key={key.id}>
                            <div className="keyModelPoolHeader">
                              <span className={`keyStatusDot ${key.enabled ? key.status : "disabled"}`} />
                              <strong>{key.label}</strong>
                              <small>{key.models?.filter((m) => m.active).length ?? 0} 个模型</small>
                              <button onClick={() => syncProviderKey(provider, key.id)} disabled={busy}><RefreshCw size={12} />同步</button>
                              <button className="expandToggle" onClick={() => toggleKeyPool(key.id)}>{isPoolExpanded ? "▲" : "▼"}</button>
                            </div>
                            {isPoolExpanded && key.models && key.models.length > 0 && (
                              <div className="keyModelPool">
                                <div className="modelPoolHeaderRow">
                                  <input value={modelSearch[`${provider.id}:${key.id}`] ?? ""} onChange={(event) => setModelSearch((current) => ({ ...current, [`${provider.id}:${key.id}`]: event.target.value }))} placeholder="搜索模型" />
                                  <button onClick={() => selectVisibleKeyModels(provider.id, key.id)}>全选</button>
                                  <button onClick={() => clearKeySelectedModels(provider.id, key.id)}>清空</button>
                                  <button onClick={() => addSelectedKeyModels(provider, key)}>加入路由</button>
                                </div>
                                <div className="modelPoolHeaderRow">
                                  <select value={groupTargets[`${provider.id}:${key.id}`] ?? ""} onChange={(event) => setGroupTargets((current) => ({ ...current, [`${provider.id}:${key.id}`]: event.target.value }))}>
                                    <option value="">加入已有分组</option>
                                    {existingAliases.map((alias) => <option key={alias} value={alias}>{alias}</option>)}
                                  </select>
                                  <button onClick={() => addSelectedKeyModels(provider, key, groupTargets[`${provider.id}:${key.id}`])} disabled={!groupTargets[`${provider.id}:${key.id}`]}>加入分组</button>
                                </div>
                                <div className="modelPoolHeaderRow newGroupRow">
                                  <input value={newGroupTargets[`${provider.id}:${key.id}`] ?? ""} onChange={(event) => setNewGroupTargets((current) => ({ ...current, [`${provider.id}:${key.id}`]: event.target.value }))} placeholder="新建分组名" />
                                  <button onClick={() => addSelectedToNewGroup(provider, key)} disabled={!(newGroupTargets[`${provider.id}:${key.id}`] ?? "").trim()}>新建并加入</button>
                                </div>
                                <div className="modelPoolList">
                                  {groupedKeyModels(key, provider.id).map(([category, models]) => (
                                    <div className="modelCategory" key={category}>
                                      <div className="modelCategoryHeader">
                                        <span>{category} · {models.length}</span>
                                        <button onClick={() => selectCategoryKeyModels(provider.id, key.id, category)}>全选</button>
                                      </div>
                                      <div className="modelCategoryList">
                                        {models.map((model) => (
                                          <label className={`modelLabel ${hiddenModels.includes(model.id) ? "modelHidden" : ""} ${favoriteModels.includes(model.id) ? "modelFavorite" : ""}`} key={model.id}>
                                            <input checked={(selectedModels[`${provider.id}:${key.id}`] ?? []).includes(model.id)} onChange={() => toggleKeySelection(provider.id, key.id, model.id)} type="checkbox" />
                                            <span>{model.id}</span>
                                            <span className="modelActions">
                                              <button title={favoriteModels.includes(model.id) ? "取消收藏" : "收藏"} onClick={(e) => { e.preventDefault(); toggleFavoriteModel(model.id); }}>{favoriteModels.includes(model.id) ? "★" : "☆"}</button>
                                              <button title={hiddenModels.includes(model.id) ? "取消隐藏" : "隐藏"} onClick={(e) => { e.preventDefault(); toggleHiddenModel(model.id); }}>{hiddenModels.includes(model.id) ? "显示" : "隐藏"}</button>
                                            </span>
                                          </label>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="providerRoutes">
                    <div className="providerRoutesHeader">路由 ({providerRoutes.length})</div>
                    {providerRoutes.length === 0 ? (
                      <div className="providerRoutesEmpty">暂无路由</div>
                    ) : (
                      providerRoutes.map((route) => {
                        const keyLabel = provider.apiKeys.find((key) => key.id === route.keyId)?.label;
                        return (
                        <div className={`providerRouteItem ${route.enabled ? "" : "disabled"}`} key={route.id}>
                          <span><strong>{route.alias}</strong> ← {keyLabel ? `${keyLabel} / ` : ""}{route.upstreamModel}</span>
                          <small className={`routeStatus ${route.status === "valid" ? "valid" : route.status === "invalid" ? "invalid" : ""}`}>{route.status ?? "unknown"} · 成本{costTierLabel(route.costTier)}</small>
                          <div className="actions">
                            <button title={route.enabled ? "停用" : "启用"} onClick={() => toggleRouteEnabled(route)} style={{ color: route.enabled ? "#256247" : "#9f1239" }}><Power size={14} /></button>
                            <button title="编辑" onClick={() => { setRouteDraft({ ...route, costTier: route.costTier ?? "medium", costNote: route.costNote ?? "" }); setShowQuickRoute(true); }}><Route size={14} /></button>
                            <button title="删除" onClick={() => remove(`/api/routes/${route.id}`)}><Trash2 size={14} /></button>
                          </div>
                        </div>
                        );
                      })
                    )}
                  </div>
                  </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        <div className="quickRouteBar">
          <button className="compactPrimary" onClick={() => { setShowQuickRoute(!showQuickRoute); if (!showQuickRoute) setRouteDraft(emptyRoute); }}>
            {showQuickRoute ? "收起路由表单" : "+ 添加路由"}
          </button>
        </div>
        {showQuickRoute && (
          <form className="quickRouteForm" onSubmit={saveRoute}>
            <label>对外模型名<input value={routeDraft.alias} onChange={(event) => setRouteDraft({ ...routeDraft, alias: event.target.value })} required /></label>
            <label>上游模型名<input value={routeDraft.upstreamModel} onChange={(event) => setRouteDraft({ ...routeDraft, upstreamModel: event.target.value })} required /></label>
            <label>供应商<select value={routeDraft.providerId} onChange={(event) => setRouteDraft({ ...routeDraft, providerId: event.target.value })} required><option value="">选择</option>{state.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>成本<select value={routeDraft.costTier} onChange={(event) => setRouteDraft({ ...routeDraft, costTier: event.target.value as RouteDraft["costTier"] })}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
            <button className="primary" disabled={busy || state.providers.length === 0}>{routeDraft.id ? <Save size={14} /> : <Plus size={14} />}{routeDraft.id ? "保存" : "添加路由"}</button>
          </form>
        )}
        </>
        )}
      </section>

      <section className="panel unavailablePanel" style={sectionStyle("unavailable")}>
        <div className="sectionTitle"><h2>无法调用</h2><div className="titleActions"><button className="dangerButton" onClick={cleanupInvalidRoutes}>一键删除无效模型</button>{sectionControls("unavailable")}</div></div>
        <div className="unavailableGroups">
          {unavailableGroups.length === 0 ? <small>暂无无法调用的模型候选</small> : collapsed.unavailable ? (
            <div className="list compactList previewList">
              {unavailableRoutes.slice(0, previewLimit).map((route) => {
                const provider = state.providers.find((item) => item.id === route.providerId);
                const failedAt = route.lastFailedAt ?? route.lastCheckedAt;
                return (
                  <article className="item" key={route.id}>
                    <div>
                      <strong>{route.alias} · {provider?.name ?? "未知供应商"} / {route.upstreamModel}</strong>
                      <span>{route.disabledReason ?? route.lastError ?? "不可调用"}</span>
                      <small>{failureSourceLabel(route.failureSource)} · 失败 {route.failureCount ?? 0} 次 · {failedAt ? formatDateTime(failedAt) : "暂无检测时间"}</small>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : unavailableGroups.map(([alias, routes]) => (
            <div className="unavailableGroup" key={alias}>
              <div className="unavailableGroupHeader">
                <strong>{alias}</strong>
                <span>{routes.length} 个不可用候选</span>
              </div>
              <div className="list compactList">
                {routes.map((route) => {
                  const provider = state.providers.find((item) => item.id === route.providerId);
                  const failedAt = route.lastFailedAt ?? route.lastCheckedAt;
                  return (
                    <article className="item" key={route.id}>
                      <div>
                        <strong>{provider?.name ?? "未知供应商"} / {route.upstreamModel}</strong>
                        <span>{route.disabledReason ?? route.lastError ?? "不可调用"}</span>
                        <small>{failureSourceLabel(route.failureSource)} · 失败 {route.failureCount ?? 0} 次 · {failedAt ? formatDateTime(failedAt) : "暂无检测时间"}</small>
                      </div>
                      <div className="actions">
                        <button onClick={() => recoverRoute(route)}><RefreshCw size={17} />检测恢复</button>
                        <button onClick={() => remove(`/api/routes/${route.id}`)}><Trash2 size={17} /></button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel commandPanel" style={sectionStyle("usage")}>
        <div className="sectionTitle"><h2>调用方式</h2>{sectionControls("usage")}</div>
        <><div className={`commandGrid ${collapsed.usage ? "previewGrid" : ""}`}><div><span>Base URL</span><code>http://127.0.0.1:{state.settings.port}/v1</code></div><div><span>模型列表</span><code>GET /v1/models</code></div><div><span>聊天补全</span><code>POST /v1/chat/completions</code></div></div>{!collapsed.usage && <p><Power size={16} />客户端需要在请求头中携带 API Key：<code>Authorization: Bearer sk-hub-xxx</code></p>}</>
      </section>

      <section className="panel clientKeysPanel" style={sectionStyle("clientkeys")}>
        <div className="sectionTitle"><h2>接口 API Key</h2><div className="titleActions"><span>{clientKeys.length} 个 Key</span>{sectionControls("clientkeys")}</div></div>
        {!collapsed.clientkeys && <>
          <div className="clientKeyCreate">
            <input value={clientKeyLabel} onChange={(event) => setClientKeyLabel(event.target.value)} placeholder="Key 名称，例如 Cherry Studio" />
            <input value={clientKeyValue} onChange={(event) => setClientKeyValue(event.target.value)} placeholder="自定义值（留空自动生成）" />
            <button onClick={createClientKey}><Plus size={14} />生成 Key</button>
            <button className={revealClientKeys ? "activeToggle" : ""} onClick={() => { setRevealClientKeys(!revealClientKeys); }}>{revealClientKeys ? "隐藏明文" : "显示明文"}</button>
          </div>
          <div className="clientKeyList">
            {clientKeys.length === 0 ? <small>暂无客户端 Key，请生成一个</small> : clientKeys.map((key) => (
              <div className={`clientKeyItem ${key.enabled ? "" : "disabled"}`} key={key.id}>
                <span className="clientKeyLabel">{key.label}</span>
                <code className="clientKeyValue">{revealClientKeys ? (key as { value?: string }).value ?? key.preview : key.preview}</code>
                <small className="clientKeyMeta">{key.enabled ? "启用" : "停用"}{key.lastUsedAt ? ` · 最近使用 ${new Date(key.lastUsedAt).toLocaleString()}` : " · 未使用"}</small>
                <div className="clientKeyActions">
                  <button title={key.enabled ? "停用" : "启用"} onClick={() => toggleClientKey(key.id, key.enabled)}><Power size={13} /></button>
                  <button title="删除" onClick={() => deleteClientKey(key.id)}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        </>}
      </section>

      <section className="panel diagnosticsPanel" style={sectionStyle("diagnostics")}>
        <div className="sectionTitle"><h2>配置诊断</h2><div className="titleActions"><button className="iconButton" onClick={load}><RefreshCw size={18} /></button><button className="iconButton" onClick={clearDiagnostics}><Trash2 size={18} /></button>{sectionControls("diagnostics")}</div></div>
        <div className="diagnosticList">{visibleDiagnostics.length === 0 ? <small>暂无明显问题</small> : visibleDiagnostics.slice(0, collapsed.diagnostics ? previewLimit : visibleDiagnostics.length).map((issue, index) => <small className={`diag ${issue.level}`} key={`${issue.message}-${index}`}><span>{issue.level} · {issue.message}</span>{!collapsed.diagnostics && <button onClick={() => hideDiagnostic(issue.message)}>删除</button>}</small>)}</div>
      </section>

      </>
      )}
    </main>
  );
}

function Metric({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint: string }) {
  return <article className="metric"><div className="metricIcon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></article>;
}

function FlowCard({ log }: { log: RequestLog }) {
  return (
    <div className={`flowCard ${log.status}`}>
      <span className="flowTime">{new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      <strong className="flowModel">{log.model}</strong>
      <span className="flowArrow">›</span>
      <span className="flowCandidate">{log.providerName ?? "未知"} / {log.upstreamModel ?? "-"}</span>
      <span className={`flowStatus ${log.status}`}>{logStatusLabel(log.status)}{log.statusCode ? ` ${log.statusCode}` : ""}</span>
      <span className="flowLatency">{log.latencyMs}ms</span>
      <span className="flowTokens">{log.totalTokens ? `${log.completionTokens ?? "-"}/${log.totalTokens}` : "-"}</span>
      {log.error && <span className="flowError" title={log.error}>{log.error}</span>}
    </div>
  );
}

async function request(url: string, init?: RequestInit) {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const adminToken = getStoredAdminToken();
  if (adminToken && url.startsWith("/api/")) headers.set("authorization", `Bearer ${adminToken}`);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const response = await fetch(url, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new Error(body?.error ?? body?.message ?? `HTTP ${response.status}`) as Error & { statusCode?: number };
    error.statusCode = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function isUnauthorized(error: unknown) {
  return Boolean(error && typeof error === "object" && "statusCode" in error && Number(error.statusCode) === 401);
}

function normalizeSectionOrder(value: string[]) {
  const current = value.filter((key) => key !== "logs" && defaultSections.includes(key));
  return [...current, ...defaultSections.filter((key) => !current.includes(key))];
}

function logStatusLabel(status: RequestLog["status"]) {
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  return "重试";
}

function failureSourceLabel(source?: ModelRoute["failureSource"]) {
  if (source === "chat") return "请求失败";
  if (source === "probe") return "检测失败";
  if (source === "sync") return "同步失效";
  if (source === "recover") return "恢复检测失败";
  return "不可用";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function costTierLabel(tier?: "low" | "medium" | "high") {
  if (tier === "low") return "低";
  if (tier === "high") return "高";
  return "中";
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function getStoredAdminToken() {
  try {
    return localStorage.getItem("api-hub-admin-token") ?? "";
  } catch {
    return "";
  }
}

type LogStat = { name: string; count: number; successRate: string; avgLatency: number };

function summarizeLogs(logs: RequestLog[], groupBy: (log: RequestLog) => string): LogStat[] {
  const groups = new Map<string, RequestLog[]>();
  for (const log of logs) {
    const key = groupBy(log);
    groups.set(key, [...(groups.get(key) ?? []), log]);
  }
  return [...groups.entries()]
    .map(([name, items]) => ({
      name,
      count: items.length,
      successRate: items.length ? `${Math.round((items.filter((l) => l.status === "success").length / items.length) * 100)}` : "-",
      avgLatency: items.length ? Math.round(items.reduce((s, l) => s + l.latencyMs, 0) / items.length) : 0
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

createRoot(document.getElementById("root")!).render(<App />);
