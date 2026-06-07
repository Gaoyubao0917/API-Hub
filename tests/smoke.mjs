import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(rootDir, "dist-server", "index.js");

if (!fs.existsSync(serverEntry)) {
  throw new Error("dist-server/index.js 不存在，请先运行 npm run build");
}

let nextPort = 42137;

function makeDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `api-hub-${name}-`));
}

async function startServer(name, extraEnv = {}) {
  const port = nextPort++;
  const dataDir = makeDataDir(name);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      HEALTH_CHECK_INTERVAL_MS: "0",
      ROUTE_CHECK_INTERVAL_MS: "0",
      RECOVER_CHECK_INTERVAL_MS: "0",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await waitForHealth(port, child, () => output);
  return {
    port,
    dataDir,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

async function waitForHealth(port, child, getOutput) {
  const deadline = Date.now() + 5000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务提前退出，code=${child.exitCode}\n${getOutput()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`服务未按时启动：${lastError}`);
}

async function jsonFetch(port, endpoint, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

async function testBasicStartup() {
  const server = await startServer("basic");
  try {
    const health = await jsonFetch(server.port, "/healthz");
    assert.equal(health.body.ok, true);
    const state = await jsonFetch(server.port, "/api/state");
    assert.equal(state.response.status, 200);
    assert.equal(state.body.providers.length, 0);
    const models = await jsonFetch(server.port, "/v1/models");
    assert.equal(models.response.status, 401);
    assert.equal(fs.existsSync(path.join(server.dataDir, "state.json")), true);
  } finally {
    await server.stop();
  }
}

async function testPanelPasswordAndClientKey() {
  const server = await startServer("password", { PANEL_PASSWORD: "pw-test" });
  try {
    const before = await jsonFetch(server.port, "/api/auth/status");
    assert.equal(before.body.authenticated, false);
    assert.equal(before.body.panelPasswordEnabled, true);

    const badLogin = await jsonFetch(server.port, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "bad" })
    });
    assert.equal(badLogin.response.status, 401);

    const login = await jsonFetch(server.port, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "pw-test" })
    });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);

    const key = await jsonFetch(server.port, "/api/client-keys", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ label: "smoke" })
    });
    assert.equal(key.response.status, 201);
    assert.match(key.body.value, /^sk-hub-/);

    const models = await jsonFetch(server.port, "/v1/models", {
      headers: { authorization: `Bearer ${key.body.value}` }
    });
    assert.equal(models.response.status, 200);
    assert.equal(models.body.object, "list");
  } finally {
    await server.stop();
  }
}

async function testAdminToken() {
  const server = await startServer("admin-token", { ADMIN_TOKEN: "token-test" });
  try {
    const status = await jsonFetch(server.port, "/api/auth/status");
    assert.equal(status.body.adminTokenEnabled, true);
    assert.equal(status.body.authenticated, false);

    const noToken = await jsonFetch(server.port, "/api/state");
    assert.equal(noToken.response.status, 401);

    const withToken = await jsonFetch(server.port, "/api/state", {
      headers: { authorization: "Bearer token-test" }
    });
    assert.equal(withToken.response.status, 200);
  } finally {
    await server.stop();
  }
}

async function testStoreRecovery() {
  const dataDir = makeDataDir("recovery");
  const { Store } = await import(pathToFileURL(path.join(rootDir, "dist-server", "store.js")).href);
  let store = new Store(dataDir);
  const provider = store.createProvider({
    name: "test",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test"
  });
  assert.equal(provider.name, "test");
  fs.writeFileSync(path.join(dataDir, "state.json"), "{broken", "utf8");
  fs.writeFileSync(path.join(dataDir, "state.json.leftover.tmp"), "old", "utf8");

  store = new Store(dataDir);
  assert.equal(store.publicState().providers.length, 1);
  assert.equal(fs.existsSync(path.join(dataDir, "state.json.leftover.tmp")), false);
  assert.equal(fs.existsSync(path.join(dataDir, "state.json.bak")), true);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function testMultipartFilePassthrough() {
  let captured;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8")
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "file-smoke", object: "file" }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const server = await startServer("multipart");
  try {
    const provider = await jsonFetch(server.port, "/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "mock",
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "upstream-key",
        priority: 1
      })
    });
    assert.equal(provider.response.status, 201);

    const clientKey = await jsonFetch(server.port, "/api/client-keys", {
      method: "POST",
      body: JSON.stringify({ label: "files" })
    });
    assert.equal(clientKey.response.status, 201);

    const form = new FormData();
    form.append("purpose", "assistants");
    form.append("file", new Blob(["hello file"], { type: "text/plain" }), "hello.txt");
    const upload = await fetch(`http://127.0.0.1:${server.port}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientKey.body.value}` },
      body: form
    });
    assert.equal(upload.status, 200);
    const body = await upload.json();
    assert.equal(body.id, "file-smoke");
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "/v1/files");
    assert.equal(captured.authorization, "Bearer upstream-key");
    assert.match(captured.contentType, /^multipart\/form-data; boundary=/);
    assert.match(captured.body, /name="purpose"/);
    assert.match(captured.body, /hello file/);
  } finally {
    await server.stop();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

async function testCapabilities() {
  const server = await startServer("capabilities");
  try {
    const provider = await jsonFetch(server.port, "/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "vision-only",
        type: "openai-compatible",
        baseUrl: "http://127.0.0.1:59999/v1",
        apiKey: "upstream-key"
      })
    });
    assert.equal(provider.response.status, 201);
    const keyId = provider.body.apiKeys[0].id;
    const route = await jsonFetch(server.port, "/api/routes", {
      method: "POST",
      body: JSON.stringify({
        alias: "vision-model",
        upstreamModel: "real-vision-model",
        providerId: provider.body.id,
        keyId
      })
    });
    assert.equal(route.response.status, 201);
    const setting = await jsonFetch(server.port, "/api/model-settings/vision-model", {
      method: "PUT",
      body: JSON.stringify({ strategy: "fixed", routeId: route.body.id, capabilities: ["chat", "vision"] })
    });
    assert.equal(setting.response.status, 200);
    const clientKey = await jsonFetch(server.port, "/api/client-keys", {
      method: "POST",
      body: JSON.stringify({ label: "capability-client" })
    });
    const models = await jsonFetch(server.port, "/v1/models", {
      headers: { authorization: `Bearer ${clientKey.body.value}` }
    });
    const model = models.body.data.find((item) => item.id === "vision-model");
    assert.deepEqual(model.capabilities, ["chat", "vision"]);
  } finally {
    await server.stop();
  }
}

async function testDeleteAggregateModel() {
  const server = await startServer("delete-model");
  try {
    const provider = await jsonFetch(server.port, "/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "delete-provider",
        type: "openai-compatible",
        baseUrl: "http://127.0.0.1:59998/v1",
        apiKey: "upstream-key"
      })
    });
    const keyId = provider.body.apiKeys[0].id;
    for (const upstreamModel of ["model-a", "model-b"]) {
      const route = await jsonFetch(server.port, "/api/routes", {
        method: "POST",
        body: JSON.stringify({
          alias: "delete-me",
          upstreamModel,
          providerId: provider.body.id,
          keyId
        })
      });
      assert.equal(route.response.status, 201);
    }
    const setting = await jsonFetch(server.port, "/api/model-settings/delete-me", {
      method: "PUT",
      body: JSON.stringify({ strategy: "random", capabilities: ["chat", "vision"] })
    });
    assert.equal(setting.response.status, 200);
    const deleted = await jsonFetch(server.port, "/api/models/delete-me", { method: "DELETE" });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.deleted, 2);
    const state = await jsonFetch(server.port, "/api/state");
    assert.equal(state.body.routes.some((route) => route.alias === "delete-me"), false);
    assert.equal(state.body.modelSettings.some((item) => item.alias === "delete-me"), false);
  } finally {
    await server.stop();
  }
}

await testBasicStartup();
await testPanelPasswordAndClientKey();
await testAdminToken();
await testStoreRecovery();
await testMultipartFilePassthrough();
await testCapabilities();
await testDeleteAggregateModel();

console.log("smoke tests passed");
