# API Hub

API Hub 是一个面向个人本地使用的轻量级 AI API 聚合面板。它可以管理多个 OpenAI 兼容供应商或中转站，把不同上游模型统一映射成一个对外模型名，并通过本地 OpenAI 兼容接口提供给客户端使用。

项目重点不是商业化网关或复杂 Key 池，而是模型聚合和本地可控。例如，两个中转站里的同类模型名称不同，API Hub 可以把它们归一成同一个模型名，对客户端只暴露一个模型，并在调用时根据健康状态、延迟、优先级、成本等策略选择候选线路。

## 功能特性

- 多供应商 / 多中转站管理
- 支持 OpenAI 兼容接口
- 聚合模型多模态能力标记：文本、Responses、图片理解、图片生成、图片编辑、文件上传、音频
- 支持聊天/Responses JSON 图片输入，例如 `image_url` 或 base64 data URL
- 支持文件类 multipart 透传，例如 `/v1/files`、图片编辑、音频转写
- 从供应商 `/v1/models` 同步上游模型
- 模型别名聚合：多个上游模型可映射成同一个对外模型名
- 支持固定候选、最快优先、供应商优先级、成本优先、随机分流
- 请求失败时自动尝试下一个候选
- 候选失败熔断与手动恢复
- 模型可用性 probe 检测
- 客户端 API Key 管理
- 面板密码 / 管理令牌保护
- 配置导入导出，支持脱敏导出
- 请求日志与基础用量统计
- 本地 JSON 存储，支持状态文件备份与恢复
- Docker 部署支持
- Windows Electron 托盘版支持

## 适用场景

- 本地统一管理多个 AI API 中转站
- 给 Cherry Studio、Open WebUI、Continue、Cline 等 OpenAI 兼容客户端提供统一 Base URL
- 把不同供应商的模型名整理成更好记的本地模型名
- 在多个候选线路之间自动切换，提高可用性

## 快速开始

```bash
npm install
npm run build
npm start
```

打开面板：

```text
http://127.0.0.1:3127
```

客户端 Base URL：

```text
http://127.0.0.1:3127/v1
```

## 开发命令

```bash
npm run dev
npm run typecheck
npm run build
npm run test:smoke
```

`test:smoke` 会使用临时数据目录启动本地服务，验证空配置启动、面板密码、客户端 Key、管理令牌和状态文件恢复。

## Docker

在目标设备上安装 Docker 和 Docker Compose 后：

```bash
git clone <your-repo-url>
cd multi-api-panel
cp .env.example .env
```

编辑 `.env`，至少修改：

```env
PANEL_PASSWORD=your-panel-password
SESSION_SECRET=your-long-random-session-secret
# 可选：调大图片 / 文件请求限制
# JSON_BODY_LIMIT=50mb
# UPLOAD_BODY_LIMIT=200mb
```

启动：

```bash
docker compose up --build
```

后台运行：

```bash
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f
```

停止：

```bash
docker compose down
```

数据会保存在项目目录下的 `data/state.json`。请不要把 `data/` 上传到公开仓库。

## Windows 桌面版

开发运行托盘版：

```bash
npm run desktop
```

生成 Windows portable exe：

```bash
npm run dist:win
```

桌面版能力：

- 启动后出现在系统托盘
- 托盘菜单可打开面板、暂停服务、恢复服务、退出
- 托盘菜单可勾选开机自启
- 托盘菜单可创建桌面快捷方式
- 桌面版数据目录使用系统用户数据目录，不依赖源码目录

## 接入客户端

在支持 OpenAI 接口的客户端中设置：

```text
Base URL: http://127.0.0.1:3127/v1
API Key: 在面板中创建的客户端 Key
```

图片和文件输入：

- `/v1/chat/completions` 和 `/v1/responses` 支持 OpenAI 兼容 JSON 图片输入，系统会保留原请求结构并只替换模型名。
- `/v1/files`、`/v1/images/edits`、`/v1/images/variations`、`/v1/audio/transcriptions`、`/v1/audio/translations` 会以 multipart/raw 方式透传到优先级最高的可用供应商。
- multipart 请求不解析文件内容，也不做模型别名改写；请确保默认供应商支持对应端点。
- 面板里可以为每个聚合模型勾选多模态能力；`/v1/models` 会返回每个聚合模型的 `capabilities`，避免把不支持图片或文件的模型误展示成全能力模型。

示例：

```bash
curl http://127.0.0.1:3127/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer sk-hub-xxx" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

## 安全配置

建议至少配置面板密码：

```bash
PANEL_PASSWORD=change-me npm start
```

也可以使用环境变量：

```bash
PORT=3127
DATA_DIR=./data
PANEL_PASSWORD=change-me
SESSION_SECRET=change-this-random-long-secret
```

`ADMIN_TOKEN` 仍可作为管理接口的兼容保护方式，但新部署更推荐使用 `PANEL_PASSWORD`。客户端访问 `/v1/*` 始终应使用面板中创建的客户端 API Key。

## 健康检查

默认每 10 分钟同步一次已启用供应商的 `/v1/models`：

```bash
HEALTH_CHECK_INTERVAL_MS=600000 npm start
```

如果某个模型在同步结果里消失，相关候选路由会被自动清理。想改成只停用不删除，可以设置：

```bash
AUTO_DELETE_INVALID_ROUTES=false npm start
```

## 模型聚合示例

假设：

- 中转站 A 的模型叫 `一`
- 中转站 B 的模型叫 `1.1`

同步模型后，在模型路由里把 B 的对外模型名也改成 `一`。此时 `/v1/models` 只暴露一个 `一`，但内部有两个候选。调用 `model: "一"` 时，系统会根据当前策略选择候选，并在可重试失败时尝试下一个候选。

## 上传公开仓库前

请确认以下文件没有进入仓库：

- `data/`
- `.env`
- `dist/`
- `dist-server/`
- `release/`
- `node_modules/`

真实 API Key、面板密码、会话密钥和运行数据都不应该提交到公开仓库。
