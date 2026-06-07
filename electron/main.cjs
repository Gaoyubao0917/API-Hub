const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, Notification } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let tray;
let mainWindow;
let serverModule;
let notificationInterval;

app.setName("API Hub");

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = path.join(app.getPath("userData"), "data");
}

const PORT = Number(process.env.PORT || readSavedPort() || 3127);
const PANEL_URL = `http://127.0.0.1:${PORT}`;
process.env.PORT = String(PORT);

function iconPath() {
  return path.join(app.getAppPath(), "electron", "assets", "icon.png");
}

function readSavedPort() {
  try {
    const statePath = path.join(process.env.DATA_DIR || path.join(app.getPath("userData"), "data"), "state.json");
    if (!fs.existsSync(statePath)) return undefined;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return Number(state?.settings?.port) || undefined;
  } catch {
    return undefined;
  }
}

function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "API Hub",
    icon: iconPath(),
    webPreferences: {
      sandbox: true
    }
  });

  mainWindow.loadURL(PANEL_URL);
  mainWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

async function loadServerModule() {
  if (serverModule) return serverModule;
  const serverPath = path.join(app.getAppPath(), "dist-server", "index.js");
  serverModule = await import(pathToFileURL(serverPath).href);
  return serverModule;
}

function sendNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: iconPath() }).show();
  }
}

async function fetchLocalApi(endpoint) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function getTrayStatus() {
  const state = await fetchLocalApi("/api/state");
  if (!state) return { running: true, providerCount: "- ", routeCount: "- ", diagCount: 0 };
  const diag = await fetchLocalApi("/api/diagnostics");
  const issues = diag?.issues ?? [];
  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.filter((i) => i.level === "warning").length;
  return {
    running: true,
    providerCount: `${state.providers?.length ?? "-"} `,
    routeCount: `${state.routes?.length ?? "-"} `,
    diagCount: issues.length,
    errors,
    warnings
  };
}

function runStartupCheck() {
  const dataDir = process.env.DATA_DIR || path.join(app.getPath("userData"), "data");
  const statePath = path.join(dataDir, "state.json");
  const warnings = [];

  if (!fs.existsSync(dataDir)) {
    warnings.push("数据目录未创建，会自动创建");
  }
  if (!fs.existsSync(statePath)) {
    warnings.push("尚未创建状态文件，初始化后自动生成");
  } else {
    try {
      const raw = fs.readFileSync(statePath, "utf8");
      const state = JSON.parse(raw);
      const providers = state?.providers ?? [];
      const withoutKey = providers.filter((p) => !p.apiKeys?.length);
      if (providers.length === 0) warnings.push("暂无供应商，请在面板中配置中转站");
      if (withoutKey.length > 0) warnings.push(`${withoutKey.length} 个供应商没有 API Key`);
    } catch {
      warnings.push("状态文件损坏，将在运行时重建");
    }
  }

  if (warnings.length > 0) {
    sendNotification("API Hub 启动检查", warnings.join("，"));
  }
}

async function runHealthNotification() {
  const status = await getTrayStatus();
  if (status.errors > 0) {
    sendNotification(`API Hub 检测到 ${status.errors} 个错误`, `共 ${status.diagCount} 个诊断问题，请在面板中查看处理`);
  }
  updateTrayMenu();
}

async function startService() {
  const server = await loadServerModule();
  server.startServer();
  updateTrayMenu();
  runStartupCheck();
  if (notificationInterval) clearInterval(notificationInterval);
  notificationInterval = setInterval(() => runHealthNotification(), 5 * 60 * 1000);
  notificationInterval.unref();
}

async function stopService() {
  if (!serverModule) return;
  await serverModule.stopServer();
  if (notificationInterval) {
    clearInterval(notificationInterval);
    notificationInterval = undefined;
  }
  updateTrayMenu();
}

function serviceRunning() {
  return Boolean(serverModule?.isServerRunning?.());
}

function openAtLogin() {
  return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: app.getPath("exe")
  });
  updateTrayMenu();
}

function createDesktopShortcut() {
  const shortcutPath = path.join(app.getPath("desktop"), "API Hub.lnk");
  const ok = shell.writeShortcutLink(shortcutPath, {
    target: app.getPath("exe"),
    cwd: path.dirname(app.getPath("exe")),
    description: "API Hub 本地多中转站模型聚合面板",
    icon: app.getPath("exe"),
    iconIndex: 0
  });
  dialog.showMessageBox({
    type: ok ? "info" : "error",
    title: "API Hub",
    message: ok ? "桌面快捷方式已创建。" : "创建桌面快捷方式失败。"
  });
}

let cachedTrayStatus = { running: true, providerCount: "- ", routeCount: "- ", diagCount: 0, errors: 0, warnings: 0 };

async function updateTrayMenu() {
  if (!tray) return;
  const running = serviceRunning();

  if (running) {
    const status = await getTrayStatus();
    if (status) cachedTrayStatus = status;
  }

  const tooltip = running
    ? `API Hub · 服务运行中 ${PORT}\n供应商 ${cachedTrayStatus.providerCount}· 路由 ${cachedTrayStatus.routeCount}\n诊断 ${cachedTrayStatus.diagCount} 项${cachedTrayStatus.errors ? ` · ${cachedTrayStatus.errors} 个错误` : ""}${cachedTrayStatus.warnings ? ` · ${cachedTrayStatus.warnings} 个警告` : ""}`
    : "API Hub · 服务已暂停";

  const contextMenu = Menu.buildFromTemplate([
    { label: `API Hub · 端口 ${PORT}`, enabled: false },
    { label: running ? "服务运行中" : "服务已暂停", enabled: false },
    ...(running && cachedTrayStatus.diagCount > 0 ? [
      { label: `诊断 ${cachedTrayStatus.diagCount} 项${cachedTrayStatus.errors ? ` · ${cachedTrayStatus.errors} 个错误` : ""}${cachedTrayStatus.warnings ? ` · ${cachedTrayStatus.warnings} 个警告` : ""}`, enabled: false }
    ] : []),
    { type: "separator" },
    { label: "打开面板", click: () => createWindow(), enabled: running },
    { label: "在浏览器打开", click: () => shell.openExternal(PANEL_URL), enabled: running },
    { type: "separator" },
    { label: "修复（同步+检测恢复）", click: async () => {
      const result = await fetchLocalApi("/api/repair/run");
      if (result) {
        sendNotification("API Hub 修复完成", `同步 ${result.synced} 个供应商，恢复 ${result.recovered} 条候选`);
      } else {
        sendNotification("API Hub 修复失败", "无法访问管理接口");
      }
      updateTrayMenu();
    }, enabled: running },
    { label: "同步全部供应商", click: async () => {
      await fetchLocalApi("/api/providers/sync-all");
      updateTrayMenu();
    }, enabled: running },
    { type: "separator" },
    { label: "恢复服务", click: () => startService(), enabled: !running },
    { label: "暂停服务", click: () => stopService(), enabled: running },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: openAtLogin(),
      click: (item) => setOpenAtLogin(item.checked)
    },
    { label: "创建桌面快捷方式", click: () => createDesktopShortcut() },
    { label: "数据目录", click: () => shell.openPath(process.env.DATA_DIR) },
    { type: "separator" },
    {
      label: "退出",
      click: async () => {
        app.isQuiting = true;
        if (notificationInterval) clearInterval(notificationInterval);
        await stopService().catch(() => undefined);
        app.quit();
      }
    }
  ]);
  tray.setToolTip(tooltip);
  tray.setContextMenu(contextMenu);
}

app.whenReady().then(async () => {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.on("double-click", () => createWindow());
  await startService();
  createWindow();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

process.on("uncaughtException", (error) => {
  dialog.showErrorBox("API Hub 错误", error.stack || error.message);
});
