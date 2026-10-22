# 架构与踩坑记录

实现过程中的关键技术点和踩过的坑。**第 11、12 节是两次真实事故的复盘，值得先读。**

---

## 一、为什么用「插件」而不是「preset」

DeepSeek Harness 的 Web 端每个会话挂载一个 **agent preset**，会话身份（persona）由 preset 决定，且 preset 的 persona 会遮蔽部署级 persona。

| 方案 | 问题 |
|---|---|
| 改部署 persona | Web 上被 preset 遮蔽，不生效 |
| 做 preset | 微信通道的 `agentPreset` 是**静态配置**，改它要重启 `dsh web` |
| **插件热挂载** ✅ | 命令注册表运行时可增，不用重启 |

而且 preset 是「整个会话的身份」，我们需要的是**按需开关**，命令式切换更灵活。

---

## 二、为什么加命令不用重启

微信桥的命令处理分两段：

1. **硬编码分支**：`/new`、`/reset`、`/bot-ping` 等，在 `bridge.ts` 里写死，直接 `return`，不经模型。
2. **通用派发**：其他斜杠命令走 `this.ctx.commands.execute(agent, line, signal)` —— 查 Harness 的命令注册表。

所以插件调用 `ctx.commands.register()` 后，微信桥下一条消息就能识别。

### 配置热加载

`dsh-app-boot` 启动时会：

```js
if (ctx.get("hmr") === void 0) {
  await ctx.loader.create({
    name: "@deepseek-ai/cordis-plugin-hmr",
    config: { root: [] }        // 只监听配置，不监听源码
  });
}
await watchUserPatches(ctx, { filename: profilePatchPath });
```

**即使 web bundle 把 `hmr` 那行 `disabled: true`，启动代码也会自己补建一个 config-only 的实例。**
所以 `cordis.patch.yml` 是热监听的。

---

## 三、坑：改了源码不生效（ESM 缓存）

**现象**：改 `impl.mjs` 存盘，命令行为没变。

**原因**：HMR 只监听配置文件，**不监听源码**；而 Node 的 ESM 模块**按路径缓存**，同路径再 `import` 仍是第一次的实例。

**解法**：入口稳定 + 实现用 `?v=<version>` 查询串导入。Node 把带不同查询串的同一文件视为**不同模块实例**。

```
index.mjs  --import('./impl.mjs?v=1.0.0+687c4e82')-->  impl.mjs
```

版本号变化即触发重新 import。而版本号的「哈希后缀」由 `sync-version.sh` 自动从代码内容算出 —— **「忘了升版本」这件事从流程上被消除**。

---

## 四、坑：Node 只解 zstd 第一帧

**现象**：解析会话日志只拿到 185 个字符。

**原因**：会话日志是**多帧追加**的 zstd。`zlib.zstdDecompressSync` 和 `createZstdDecompress` 都**只解第一帧**。
实测 2MB 文件 Node 解出 185 字符，`zstd -dc` 解出 6375 行。

**解法**：shell 出去调 `zstd -dc`。单次约 80–100ms，人工触发的命令完全够用。

---

## 五、`inject` vs `followup`

| API | 效果 |
|---|---|
| `inject(msg)` | 排到 `next-step`，**不唤醒驱动** |
| `steer(msg)` | 排到 `next-step`，唤醒 |
| `followup(msg)` | 排到 `next-turn`，**开一轮新对话** |

人设必须用 `inject`：用 `followup` 会凭空多一轮对话（用户发 `/new` 后机器人自己蹦出一条消息）。

注入的内容会持久化 —— 循环在 `preStep` 取用后执行
`session.append("user/message", message)`，所以人设能持续多轮。

**已知限制**：超长会话触发 compaction 时，早期注入的人设可能被压缩掉，重发 `/whale` 即可。

---

## 六、跨 `/new` 继承

监听 `agent/created`，新会话若属于本通道（session id 前缀过滤）且开关为开启态，则注入人设。

---

## 七、真会话切换怎么做（1.2.0 起支持）

**结论先放**：0.1 时代确实做不到；**1.2.0 通过「通道插件补丁 + 请求文件」做到了**，但默认仍不启用。

### 难点在哪

当前微信会话 id 存在通道插件 `ConversationManager` 的 `private activeIds` 里。该类未导出、
映射一旦写入就读缓存，外部读不到也改不了；磁盘层的 hack 无效，因为缓存已存在。
所以「真切换」只能在通道插件内部实现。

### 1.2.0 的做法

1. `/load <n> --hard` 只做一件事：把 `{targetId}` 写进 `$DSH_HOME/.whale-commands/pending-switch.json`（0600）
2. 通道插件在**命令执行完成后**读取该文件并执行切换：取消当前工作 → 释放绑定 →
   `activeIds.set(baseId, targetId)` → `resume(target)`（失败自动回滚到原会话）
3. 没打补丁的通道：命令直接拒绝并提示「通道未打补丁」，**默认的 `/load <n>`（注入上下文）照常可用**

### 风险控制

- 补丁只在**命令结束后**触发切换，不打断长轮询；切换失败会回滚
- 切换目标若已绑定 → 视为成功（幂等），避免抢写锁
- 默认行为仍是「注入上下文」，老用户零感知；真切换是显式 opt-in

> 详见 [`COMPATIBILITY.md`](COMPATIBILITY.md) 与 `patches/weixin-harness-0.2.diff`。

---

## 八、主动推送

```
POST {baseUrl}/ilink/bot/sendmessage
Authorization: Bearer <token>
{
  msg: {
    from_user_id: "",
    to_user_id: "<用户 id>",
    client_type: 2, message_state: 2,
    item_list: [{ type: 1, text_item: { text } }]
  },
  base_info: { channel_version: "0.2.5", bot_agent: "..." }
}
```

关键：**`context_token` 是可选字段** —— 没有入站消息也能主动推送。定时问候就靠这个。

`to_user_id` 从凭据的 `userId` 取。验证方法（零成本）：

```
sha256(accountId + "\0" + userId).slice(0, 32) === 微信通道 session id 的后半段
```

对上就说明 `userId` 确实是收件人。官方就是这么算 session id 的。

---

## 九、启动安全：fail-loud 守卫

`dsh-app-boot` 里有一条守卫：

```js
assertEntriesActivated(): 任一 entry「import 失败 / 激活被拒 / 没变 active」→ 抛错
installFailLoud():        → 打印 "fatal load failure" → process.exit(1)
```

**含义**：任何一个 loader entry 加载失败，整个 `dsh web` 就退出了，systemd 每 5 秒重试 → 崩溃循环。

因此本插件的入口设计成**绝不 reject**：任何失败都降级为「没有命令」，让服务正常启动。

同理，补丁文件的两条硬失败路径：

| 情况 | 结果 |
|---|---|
| `cordis.patch.yml` **缺失** | 安全（当作没有补丁） |
| `cordis.patch.yml` **语法错误** | ❌ 启动失败 |
| **入口文件不存在** | ❌ 启动失败（loader import 失败） |

编辑 `cordis.patch.yml` 务必先验证 YAML。

---

## 十、`read_image` 为什么用不了

`dsh-llm-deepseek` 适配器把 `inputModalities` **硬编码成 `["text"]`**，序列化器里还有
`assertTextOnly()` 会拒绝图片块，且**完全没有图片序列化逻辑**。

但模型本身能看图 —— 直连 `api.deepseek.com` 发 OpenAI 风格的 `image_url`（base64 data URL）
可以正常识别。所以限制在 Harness 适配器，不在模型或 API。

**不要去打补丁改 provider**：适配器需要重写图片序列化 + 接附件服务，且上游是否接受取决于
部署；风险高收益低。绕过方案：外部脚本直连 API 看图。

> 另一条更安全的路：`llm-pi-ai` 供应商支持 `openai-completions` 协议且实现了图片输入，
> 用配置方式指定 `input: [text, image]` 即可，不需要改 dist。但需要单独的视觉模型凭据。

---

## 十一、事故复盘：重挂时命令全部消失

**现象**：改完插件后，所有命令变成「未知命令」。

**原因**：把入口从 `index.mjs` 换成 `index-v2.mjs`，**但 `config.version` 没变**。
于是新旧实例加载的是**同一个 impl 模块实例**，重挂瞬间两套命令注册撞车 →
旧代码是「一条失败整段中止」→ 8 条全都没注册上 → 旧实例销毁后**归零**。

**更糟的是**：入口当时把错误全部吞掉（为了保服务不死），所以**完全没有留痕**，只能靠用户发现。

**修复**：

1. **进程级注册去重**：把 disposer 登记到 `globalThis[Symbol.for("whale-commands.registrations")]`，
   跨模块实例共享。每次 apply 先释放上一批，再注册新的 —— 重挂多少次都只有一套。
2. **自愈重试**：万一仍撞车，失败的条目会在 600ms / 1.8s / 4s / 8s 后自动补注册。
3. **失败留痕**：注册结果逐条写入 `plugin.log`（`register ok` / `register FAILED` / `apply done: ok=N`）。

**验证**：连续两次重挂，日志均为 `released=8 ok=8`。

---

## 十二、事故复盘：备份/文档/脚本里的「写死」

同一次事故里暴露出一类**同源问题**：把会变的东西写死。

| 位置 | 写死了什么 | 后果 |
|---|---|---|
| 还原脚本 | 入口文件名 `index-v2.mjs` | 入口改名后校验误报「入口缺失」 |
| 使用说明 | 文件清单、卸载命令、版本示例 | 全部过期，照着做会失败 |
| 备份快照 | 修复**前**的代码 | 还原会把 bug 一起恢复 |

**修法**：

- 入口文件名一律从 `cordis.patch.yml` 的 `name` **动态解析**，不写死
- 文档里的路径用目录而非具体文件名
- 代码一改就重拍快照

**通用教训**：任何「配置 A 里记着文件 B 的名字/版本」的地方，都要有机制保证 A 与 B 一致，
要么自动同步（哈希），要么动态读取，要么显式校验。靠人的记忆一定会出事。

---

## 十三、文件布局

```
dsh-whale-commands/            仓库
├── src/
│   ├── index.mjs              入口（加固：永不抛错，失败只降级）
│   ├── impl.mjs               实现（8 个命令）
│   └── weixin-send.mjs        iLink 主动推送模块
├── scripts/sync-version.sh    内容哈希 → 版本号
├── greetings/
│   ├── morning.sh             定时问候（双风格随机）
│   └── push.mjs               命令行推送入口
├── install.sh / uninstall.sh
└── docs/ARCHITECTURE.md       本文件

安装后：
~/.dsh/
├── .whale-commands/
│   ├── persona.state          人设开关 on/off
│   ├── style.state            问候风格 random/whale/imperial
│   ├── hidden.commands        /help 菜单隐藏名单（可选，一行一个命令名）
│   ├── plugin.log             注册诊断（看 apply done: ok=8）
│   └── greetings/             morning.sh + push.mjs + weixin-send.mjs
├── .credentials.yaml          Harness 凭据（不归本插件管）
└── profiles/web/
    ├── cordis.patch.yml       追加了挂载段
    └── plugins/whale-commands/
        ├── index.mjs
        ├── impl.mjs
        ├── weixin-send.mjs
        └── sync-version.sh
```

---

## 十四、v1.1.1 修复记录：一次「脱敏式重构」引发的回归

这个项目同时存在于本机（路径写死、只服务一台机器）和开源仓（全部走 `DSH_HOME` /
环境变量）两个版本。把本机版「参数化」成开源版的过程本身引入了几个 bug，
值得单独记一笔，因为**它们的共同特征是：改完不报错，只是不干活**。

### 1. `$NODE` 漏改（最严重）

本机版是 `NODE=/绝对路径/node`，开源版改成 `resolve_node()` + `NODE_BIN=$(resolve_node)`，
但调用点还写着 `"$NODE"`。脚本开头有 `set -u`，于是每天 7:00：

```
morning.sh: line 129: NODE: unbound variable   → exit 1
```

`push.mjs` 根本没被调用，微信端一条收不到，日志里只留一行看不懂的报错。
**教训**：把硬编码改成「探测 + 变量」时，要 grep 一遍旧变量名的所有引用；
`DRY_RUN` 路径也覆盖不到发送那一行（它在 `DRY_RUN` 分支之后），必须用桩 push 跑通全链路。

### 2. 文档里的环境变量根本不存在

README 写了 `DSH_WEIXIN_CRED_FILE` / `DSH_WEIXIN_CRED_KEY` / `DSH_WEIXIN_TO_USER`，
代码读的却是无前缀的 `WEIXIN_CRED_FILE`、键名硬编码、收件人固定取 `userId`。
用户照文档配置＝静默无效。**修法**：把三个变量真正实现（而不是删文档）。

### 3. 「只对微信通道生效」不成立

`apply(ctx)` 拿到的是插件 ctx，`ctx.commands.register()` 因此是**全局注册**
（dsh-commands 的语义：plain-context 即全局），Web GUI 也能发这些命令。
只有 `agent/created` 的人设继承做了 `weixin-` 前缀过滤。
**修法**：读微信会话数据的 6 条命令加通道闸，非微信会话直接返回错误；
`/time`、`/help` 不受影响。

### 4. 版本号漂移

`install.sh` 把基线写死 `1.0.0`，且挂载行已存在就整段跳过 —— 重装新版本时
`version` 不变，Cordis 不重挂，表现为「文件换了但行为没变」（第 11 节事故的同一类问题）。
**修法**：基线从 `package.json` 读；已挂载时改跑 `sync-version.sh`。

### 5. 顺带修掉的两个真 bug

- `/token` 的「今日累计」按会话文件 mtime 挑文件、再把**整份历史**加总 → 跨天会话会
  把昨天的量算进今天。改为按事件 `time >= 今日零点` 过滤（事件都带 `time`）。
- 今日扫描只 stat `session.jsonl.zstd`，纯 `session.jsonl` 的会话被静默漏掉。
  抽了 `sessionMtime()` 统一处理。

**通用教训**：凡是「把写死的东西变成变量/探测」的重构，都要配一个能跑通**完整链路**的
自检（桩替换掉真正发消息的那一步），否则最容易坏的恰恰是最后那一步。


---

## 附录：harness 0.1 → 0.2 迁移实录（2026-10）

0.2 删掉了 181 个包、改了 8 处与通道插件相关的接口/格式。实际踩到的坑按「致命程度」排序：

| 严重度 | 现象 | 真正原因 | 修法 |
|:--|:--|:--|:--|
| 🔴 全炸 | 任何命令都回「执行 Harness 命令时发生错误」 | `commands.execute` 从 3 参变 4 参，signal 被塞进附件位 | 自适应传参 + 附件传 `[]` |
| 🔴 全炸 | `cannot get property "agent" without inject` | 0.2 的 Cordis 要求 inject 才能读 `agentCtx.agent` | 容错取值，取不到跳过权限预设 |
| 🟠 切换/续聊炸 | `format v4 message requires a producer-owned source kind` | 0.2 的 v4 格式**禁止** `source.kind="plugin"` | 注入消息改用生产者名 |
| 🟠 续聊炸 | `session.events` 读不到 | 变成私有，公开 `snapshotEvents()` | 兼容层 |
| 🟠 续聊炸 | 会话「已存在」却 create | `list()` 返回 `{header:{id}}`，代码读 `.id` 得 undefined | 兼容读字段 |
| 🟡 功能退化 | 图片/文件消息失败 | `saveImage/readImage` → `saveImages/readImageRequest` | 兼容封装 |
| 🟡 功能退化 | 无法读取会话头 | `sessionPersistence.inspect()` 被删除 | 「有则用，无则默认」 |
| 🟢 加载失败 | 通道插件 import 失败 | `@deepseek-ai/dsh-agent-presets` 被移除 | `compat/` 垫片 |

### 排查方法论（省时间的关键）

1. **先给插件的兜底 catch 加 `error.stack` 日志**——默认它只回一句「请稍后重试」，什么都看不到
2. **进程内自检**：给插件加个环境变量开关，用伪造的入站消息直接跑 `executeCommand`，
   一条命令就能复现「用户发消息」的全链路，不用真在微信里来回试
3. **写路径 vs 读路径**：报错在 `appendLines` 说明是**写入**校验（格式问题），
   在 `read`/`list` 说明是**读取**兼容问题——两者的修法完全不同
4. 改完跑 `node --check` + 自检回归，再上真机

> 0.1 → 0.2 的完整兼容清单见 [`COMPATIBILITY.md`](COMPATIBILITY.md)。
