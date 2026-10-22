# 兼容性工程：harness 0.1 → 0.2（完整清单）

> **关键词（便于检索）**：DeepSeek Harness 0.2 兼容 · deepseek-harness-weixin 修复 ·
> `@deepseek-ai/dsh-agent-presets` 缺失 · `ERR_MODULE_NOT_FOUND` · `commands.execute` 4 参数 ·
> `agentCtx.agent` inject · `sessionPersistence.inspect` 移除 · `session.events` 私有化 ·
> `snapshotEvents()` · `list()` 返回 header · `saveImages` / `readImageRequest` ·
> `format v4 message requires a producer-owned source kind` · `source.kind="plugin"` 被拒 ·
> `SessionAlreadyOwnedError` / `SessionAlreadyExistsError` ·
> 微信通道插件 · lark / qqbot / wecom / agentchat / weixin 通道插件兼容 ·
> dsh-auth 0.3.0 · 会话格式 v0→v4

本文是 README「兼容性工程」的完整版；README 只保留摘要。

---

harness 0.2 动了底层的接口与格式，**不是插件作者能"顺手适配"的那种小改**。这次一共处理了 8 类差异：

| # | 0.1 的写法 | 0.2 的变化 | 后果 |
|:--|:--|:--|:--|
| 1 | `commands.execute(agent, line, signal)` | 变成 **4 个参数**（多 `submittedAttachments`） | 所有命令直接报错 |
| 2 | `agentCtx.agent` 直接读 | 需要 **inject 声明**才能访问 | 通道初始化失败 |
| 3 | 附件参数可省略 | 传 `undefined` 会读 `.length` 抛错 | 命令执行中断 |
| 4 | `sessionPersistence.inspect()` | **接口被删除**（只剩 open/list/stat） | 续聊/切换失败 |
| 5 | `session.events` 数组 | 改为私有，公开 `snapshotEvents()` | 读不到历史 |
| 6 | `list()` 返回 `{id}` | 改成 `{header:{id}}` | 会话被当成"不存在"→ 重复创建 |
| 7 | `attachments.saveImage/readImage` | 改名 `saveImages/readImageRequest` | 图片/文件消息失败 |
| 8 | 消息 `source.kind = "plugin"` | **v4 会话格式明令拒绝** | 只有写会话时才炸，最难发现 |

### 两个可复用的成果

1. **`compat/dsh-agent-presets` 垫片**
   0.2 移除了这个包，但一批 0.1 时代的通道插件（`lark` / `qqbot` / `wecom` / `agentchat` / `weixin`）
   仍从它导入 `resolveSessionPreset` → 加载即报 `ERR_MODULE_NOT_FOUND`。
   垫片按 0.1 语义补回该函数，放进 profile 的 `node_modules` 即可让这些插件**在 0.2 上通过模块加载**。

2. **`patches/weixin-harness-0.2.diff`**
   把上述差异整理成可验证的统一 diff（实测 `patch -p0` 应用后 `node --check` 通过），
   并附带 8 条的逐项说明与排查方法。

### 排查方法论（比补丁更值钱）

- **先让插件的兜底 catch 吐出 `error.stack`** —— 它默认只回一句"请稍后重试"，什么都看不到
- **进程内自检**：给插件加一个环境变量开关，用**伪造的入站消息**直接跑完整命令链路，
  一条命令复现"用户发消息"的场景，不用真在微信里反复试（本项目用它跑通了 `/help`、`/sessions`、续聊、切换）
- **分清读路径与写路径**：报错在 `appendLines` 说明是**写入校验**（格式问题），在 `read/list` 说明是**读取兼容**问题——两者修法完全不同

### 我们具体改了什么（逐层列清）

**① 上游微信通道插件（`deepseek-harness-weixin@0.2.5`，MIT）**
- **8 类 API/格式适配**：见上表（含最隐蔽的 `source.kind="plugin"`）
- **7 项稳定性/隔离修复**：会话快照字段、`SessionAlreadyExists` 自动 resume、`whenIdle` 容错、
  切换幂等自愈、写锁冲突可读提示、状态目录跟随 `DSH_HOME`、依赖惰性加载
- 合计 diff：**19 个 hunk / +193 行**，已验证可应用

**② 兼容垫片（`compat/`）**
- 补回被 0.2 删除的 `@deepseek-ai/dsh-agent-presets`
- 效果：`lark` / `qqbot` / `wecom` / `agentchat` / `weixin` 五个 **0.1 时代的通道插件可在 0.2 上加载**

**③ 认证层（`dsh-auth`）**
- 结论：npm 上的 `dsh-auth@0.2.3` 声明 peer `<0.2.0`，**明确不支持 0.2**
- 改用 `0.3.0`（上游 main，peer 支持 0.2）后**启动零报错**
- 踩平两个配置坑：状态文件权限必须 `0600`、结构必须 `schemaVersion: 2`
- 说明：**这是验证与配置适配，未改动上游代码**（不该冒领功劳）

**④ 本插件自身（`src/`）**
- 人设注入的来源类型改为生产者名（修 0.2 的 v4 校验）
- 全部路径跟随 `DSH_HOME`；`/load` 双模式（默认注入 / `--hard` 真切换）
- 新增 11 套人设库、`/model`、`/version` 自诊断

**⑤ 部署侧（本地实践，未进仓库）**
- 会话数据：旧格式不可读 → 生成摘要迁移（19 会话 / 474 消息）
- 影子实例 systemd 常驻 + 开机自启；状态目录与生产隔离

> 最终结果：8 条微信命令自检全过、7 项能力验收全过，且**同一份代码在 0.1 与 0.2 上都能跑**。
