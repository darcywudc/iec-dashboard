# IEC Dashboard v2 — 产品需求规格

## 核心定位

**IEC Dashboard 是 Darcy 与 OpenClaw AI 交互的主窗口。**

每个"任务"= 一个独立的 OpenClaw session，看板负责管理这些 session 的生命周期、对话历史、关联文件和上下文。

---

## 架构概览

```
IEC Dashboard (浏览器)
├── 任务看板（session 列表/管理）
├── 对话窗口（与某个 session 直接对话）
├── 文件管理（workspace 文件，支持拖拽关联）
└── 监控面板（CRS / Google Cloud / OpenAI 费用）

后端 server.js (Node.js, port 18790)
└── 代理到 OpenClaw Gateway (port 18789)
    └── /tools/invoke → sessions_list / sessions_send 等
```

---

## 数据结构

### Task（任务）

```json
{
  "id": "string",
  "title": "string",
  "description": "string",
  "status": "todo | in-progress | done | archived",
  "priority": "high | medium | low",
  "project": "string",
  "tags": ["string"],
  "dueDate": "ISO8601 | null",
  "sessionKey": "string | null",       // 绑定的 OpenClaw session key
  "files": ["path/relative/to/workspace"],  // 关联文件列表
  "contextNote": "string",             // 给 AI 的初始上下文/系统提示
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "archivedAt": "ISO8601 | null"
}
```

---

## 功能需求

### 1. 任务看板

- 看板列：**待办 / 进行中 / 完成 / 归档**
- 每个任务卡片显示：标题、项目、优先级、关联 session token 用量（进度条）、关联文件数
- 点击任务卡片 → 打开任务详情（右侧面板）
- 支持拖拽任务到不同列（改变状态）

### 2. 任务详情面板

包含三个区域：

#### 2a. 基本信息
- 标题、描述、项目、优先级、标签、截止日期（可编辑）
- Session Key（显示绑定状态，可手动输入或自动创建）
- Token 使用率进度条（实时，来自 sessions_list）

#### 2b. 对话区域
- 显示该 session 的历史消息（从 transcript 加载）
- 输入框发消息 → 通过 `/tools/invoke sessions_send` 路由到对应 session
- 支持 Markdown 渲染
- **文件拖拽**：可拖入文件，自动读取内容作为消息附件发送
- 实时通过 WebSocket 接收新消息

#### 2c. 关联文件
- 显示已关联文件列表（点击在编辑器查看）
- 支持从 workspace 文件树手动添加
- 支持拖拽文件到任务卡片自动关联

### 3. 新建任务流程

1. 填写标题、描述、项目、优先级
2. 可选：写 contextNote（AI 初始指令）
3. 可选：关联文件
4. 点"创建" → 自动生成唯一 sessionKey（格式：`task:<id>:<slug>`）
5. 第一条消息自动发送 contextNote 到新 session

### 4. Session 生命周期

- **激活** (`in-progress`) → session 正常对话
- **完成** (`done`) → session 保留但标记完成，不再主动对话
- **归档** (`archived`) → transcript 备份到 `memory/archives/`，session 可清理
- **删除** → 同归档 + 从看板移除

### 5. Telegram 联动

- 在 Telegram 发送 `/task <id>` → 切换当前对话 session 到该任务
- 在 Telegram 的对话自动同步到当前活跃任务 session（或主 session）
- 看板显示来自 Telegram 的消息（实时）

### 6. 监控面板（保留现有）

三个独立模块（现已实现，保持不动）：
- **CRS** — Claude Relay Service
- **Google Cloud** — Gemini API 用量/费用
- **OpenAI** — API 用量/费用按模型分布

### 7. Session 告警

- 每次加载任务列表时检查 token 使用率
- ≥ 75% → 任务卡片显示黄色警告
- ≥ 90% → 红色警告 + 顶部通知栏
- = 100% → 强制提示，建议 /compact 或归档

---

## 技术实现要求

### 后端 (server.js)

新增 API 端点：

```
GET  /api/tasks              → 任务列表
POST /api/tasks              → 创建任务（含初始化 session）
PATCH /api/tasks/:id         → 更新任务
DELETE /api/tasks/:id        → 删除/归档任务

GET  /api/sessions           → 所有 OpenClaw sessions（已实现）
POST /api/sessions/send      → 发消息到指定 session
GET  /api/sessions/:key/history → 获取 session 历史消息

GET  /api/files              → workspace 文件列表（已实现）
GET  /api/file?path=         → 读取文件内容（已实现）
POST /api/tasks/:id/files    → 关联文件到任务
```

### 前端 (index.html / JS)

- 单页应用，保持现有 Tab 结构
- 任务看板 Tab：Kanban 布局
- 任务详情：右侧滑出面板（侧边栏）
- 对话区：消息列表 + 输入框，支持拖拽文件
- WebSocket 实时推送：任务更新、新消息、session 状态变化

### 文件拖拽

- 拖入文件到对话区 → 读取内容 → 作为用户消息前置内容发送
- 拖入文件到任务卡片 → 关联到该任务的 files[]
- 支持 `.md`, `.txt`, `.json`, `.py`, `.js`, `.ts` 等文本文件

---

## 当前状态（v1 已实现）

- ✅ 基础看板（todo/in-progress/done）
- ✅ 任务 CRUD API
- ✅ WebSocket 实时同步
- ✅ 文件管理（读写 workspace .md 文件）
- ✅ CRS / GCP / OpenAI 监控面板
- ✅ Session 列表 + token 使用率
- ✅ Gateway 对话（基础版）
- ❌ 任务绑定 session
- ❌ 对话历史加载
- ❌ 文件拖拽关联
- ❌ session 生命周期管理
- ❌ 归档功能
- ❌ Telegram 联动

---

## 优先级（v2 实现顺序）

1. **任务绑定 session** — 核心功能，其他都依赖这个
2. **对话区加载历史 + 发消息** — 主交互入口
3. **文件拖拽** — 提升体验
4. **session 告警** — 已在 heartbeat 实现，看板同步显示
5. **归档** — 已有基础逻辑
6. **Telegram 联动** — 后期
