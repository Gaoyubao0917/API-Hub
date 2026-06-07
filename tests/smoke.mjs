import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
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
  await waitForHealth(port, child);
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

async function waitForHealth(port, child) {
  const deadline = Date.now() + 5000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务提前退出，code=${child.exitCode}`);
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

await testBasicStartup();
await testPanelPasswordAndClientKey();
await testAdminToken();
await testStoreRecovery();

console.log("smoke tests passed");
