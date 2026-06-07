export type ProviderType = "openai-compatible" | "anthropic-compatible";

export type KeyStatus = "unknown" | "healthy" | "unhealthy";

export type ProviderCapability = "chat" | "responses" | "vision" | "image-generation" | "image-edit" | "files" | "audio";

export type ApiKeyEntry = {
  id: string;
  label: string;
  value: string;
  enabled: boolean;
  status: KeyStatus;
  lastCheckedAt?: string;
  latencyMs?: number;
  error?: string;
  models: SyncedModel[];
};

export type SyncedModel = {
  id: string;
  active: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type Provider = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKeys: ApiKeyEntry[];
  lastSyncedAt?: string;
  healthStatus?: KeyStatus;
  healthError?: string;
  latencyMs?: number;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type ModelRoute = {
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
  lastError?: string;
  disabledReason?: string;
  lastFailedAt?: string;
  failureSource?: RouteFailureSource;
  costTier?: "low" | "medium" | "high";
  costNote?: string;
  createdAt: string;
  updatedAt: string;
};

export type RouteFailureSource = "chat" | "probe" | "sync" | "recover";

export type ModelStrategy = "fixed" | "fastest" | "priority" | "cost" | "random";

export type ModelSetting = {
  alias: string;
  strategy: ModelStrategy;
  routeId?: string;
  capabilities?: ProviderCapability[];
  updatedAt: string;
};

export type RequestLog = {
  id: string;
  createdAt: string;
  model: string;
  providerId?: string;
  providerName?: string;
  routeId?: string;
  upstreamModel?: string;
  status: "success" | "failed" | "retried";
  statusCode?: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  error?: string;
};

export type ClientApiKey = {
  id: string;
  label: string;
  value: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt?: string;
};

export type AppState = {
  providers: Provider[];
  routes: ModelRoute[];
  logs: RequestLog[];
  modelSettings: ModelSetting[];
  settings: {
    port: number;
    routeFailureThreshold: number;
    clientApiKeys: ClientApiKey[];
    panelPassword?: string;
  };
};

export type PublicApiKeyEntry = Omit<ApiKeyEntry, "value"> & {
  preview: string;
};

export type PublicProvider = Omit<Provider, "apiKeys"> & {
  apiKeys: PublicApiKeyEntry[];
  apiKeySet: boolean;
  keyCount: number;
  healthyKeyCount: number;
  modelCount: number;
};
