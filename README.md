# dsh-whale-commands 🐋

一个给 **DeepSeek Harness 微信通道**用的扩展命令插件。

装上之后，你可以在微信里发斜杠命令直接控制 Harness 会话：**在 11 套人设之间切换**、
翻历史对话（可注入上下文，也可**真切换会话**）、切换模型、查 token 用量与余额、
设置每天早上的定时问候。

> 命令不止 `/whale` 一个：本插件注册 **11 条命令**，`/help` 菜单里连同宿主内置命令共 **20+ 条 / 5 个分组**。
> 人设也从「一个鲸鱼娘开关」升级成**可切换的人设库**（`/persona`）。

**命令由宿主进程直接执行，不经过模型。** 所以它们不消耗 token、结果确定、响应即时，
适合放控制类操作。插件同时支持热挂载：改配置或代码后不需要重启 `dsh web`。

![status](https://img.shields.io/badge/status-可用-brightgreen)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.1%20%7C%200.2-blue)
![version](https://img.shields.io/badge/version-1.2.0-orange)
![branch](https://img.shields.io/badge/branch-feat%2Fharness--0.2-lightgrey)
![license](https://img.shields.io/badge/license-AGPL--3.0-blue)

---

> **本 README 对应分支 `feat/harness-0.2`（v1.2.0，尚未合入 main）。**
> 相比 main 的 1.1.2：新增 11 套人设库 / 模型切换 / 自诊断，并修复了 harness 0.2 的兼容问题；
> 同时新增 `compat/` 与 `patches/`，让 0.1 时代的通道插件能跑在 0.2 上。
> 合并前请跑一遍 `scripts/scan-secrets.sh` 与自检（见文末）。


## 目录

- [命令一览](#命令一览)
- [兼容性（0.1 / 0.2）](#兼容性harness-01-与-02)
- [从 0.1 升级到 0.2](#从-01-升到-02-需要注意)
- [技术要点](#技术要点)
- [安装](#安装)
- [使用](#使用)：[人设](#人设11-套可切换) · [用量与余额](#用量与余额) · [历史对话](#历史对话) · [定时问候](#定时问候) · [隐藏别人的命令](#从菜单里隐藏别的插件的命令)
- [改代码后必须做的一步](#改代码后必须做的一步)
- [卸载](#卸载) · [故障排查](#故障排查) · [环境变量](#环境变量)
- [架构与踩坑记录](docs/ARCHITECTURE.md)

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `/whale` | 开启「鲸鱼娘·大肥鱼」人设 |
| `/normal` | 退出人设，恢复正常口吻 |
| `/sessions` | 列出最近 5 个对话（标题、时间、提问数） |
| `/load <编号>` | 把该对话最近上下文载入当前会话（各版本通用） |
| `/load <编号> --hard` | **真切换**到该对话（需通道补丁；见「兼容性」） |
| `/persona [编号\|id\|off]` | 人设库（11 套）：切换 / 关闭 / 查看 |
| `/model [模型\|default ...]` | 切换本会话模型、设置 /new 默认模型 |
| `/version` | 插件版本 + 通道补丁自诊断 |
| `/time` | 当前服务器时间 |
| `/token` | 本会话用量 + 今日累计 + 账户余额 |
| `/style` | 设置早间问候风格 |
| `/help [组\|all]` | 分组菜单（talk/model/role/ext/harness），`/help all` 看全量 |

外加**定时问候**：每天 7:00 推一条「请安 + 鼓励」，文风由 `/style` 控制——
`auto`（跟随当前人设，默认）/ `random`（11 套人设全员随机）/ `<人设id>` 固定一个。

---

## 技术要点

实现过程中处理了几个 Harness 里不太直观的机制，如果你也在写 DSH 插件，这几点可以直接参考：

1. **不重启就能加命令** —— 命令注册表运行时可增，微信桥会派发任何已注册命令；改 `cordis.patch.yml` 会被 Cordis HMR 热加载。
2. **人设跨 `/new`** —— 监听 `agent/created`，新会话自动继承。
3. **注入但不打扰** —— 用 `agent.inject()` 而不是 `followup()`：只把上下文排进下一步，不凭空多开一轮对话。
4. **机器人能主动找你** —— iLink 的 `context_token` 是可选字段，所以没有入站消息也能推送。
5. **重挂不会把命令弄丢** —— 进程级注册去重 + 自愈重试（这条是踩坑踩出来的，见下）。
6. **版本号与内容强绑定** —— 内容哈希写进 `config.version`，杜绝「改了代码但没生效」。
7. **同一份代码跨 harness 版本** —— 用运行时探测（`commands.execute.length`、服务方法存在性）代替版本判断，`/version` 会把结果告诉你。
8. **`/help` 按宿主注册表自动分组** —— 命令表越大越长，所以 `/help` 只出目录（按用途分组），`/help <group>` 进子菜单看细节，`/help all` 一次列全。分组从 `ctx.commands.list()` 动态推导，装了别的插件也会自动归位；`description` 里带换行的命令，子菜单会缩进展开成多行说明。

细节与全部踩坑记录见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 安装

前置条件：

- 已装 DeepSeek Harness，且 `dsh web` 跑起来过（会生成 `~/.dsh/profiles/web/`）
- 微信通道已配置好（`~/.dsh/.credentials.yaml` 里有 `WEIXIN_ILINK_CREDENTIAL`）
- `zstd` 命令可用（`/sessions`、`/load` 读会话历史需要）
- Node.js ≥ 22

```bash
git clone https://github.com/spinoi-code/dsh-whale-commands.git
cd dsh-whale-commands
./install.sh
```

装完等几秒（Cordis HMR 自动挂载），在微信里依次发：

```
/version   → 看清版本、会话目录、通道补丁状态
/help      → 分组菜单（20+ 条命令 / 5 组）
/persona   → 11 套人设列表
```

### 装在哪一版 harness？（0.1 / 0.2 都行）

安装命令**两个版本完全一样**，插件本体同时兼容：

| 你的 harness | 直接装 | 需要额外做的 |
|:--|:--|:--|
| 0.1.x（rc.7 一系） | ✅ | 无 |
| 0.2.x | ✅ | 如果同时用其它 0.1 时代的通道插件，装 `compat/dsh-agent-presets` 垫片；想要 `/load --hard` 真切换，再打 `patches/` 里的补丁 |

装完先发 **`/version`** 自诊断：它会告诉你当前通道是否支持真切换、会话目录在哪。

### 更新（以后升级插件）

```bash
cd dsh-whale-commands && git pull
./install.sh                 # 覆盖安装
# 拿到新代码后必须同步版本号（否则 Cordis 认为没变、不会重挂）：
(cd "$HOME/.dsh/profiles/web/plugins/whale-commands" && ./sync-version.sh)
sudo systemctl restart deepseek-harness      # 或重启你自己的 dsh web
```

> 版本号规则：`1.2.0+<内容哈希>`。哈希由脚本算，**不要手改**。

### 从 0.1 升到 0.2 需要注意

1. 先升 harness，再确认本插件能加载（`/version`）
2. 另外那批通道插件（lark / qqbot / wecom / agentchat / weixin）会因 `@deepseek-ai/dsh-agent-presets` 被移除而加载失败 → 装 `compat/` 垫片
3. `/load <n> --hard` 需要通道补丁；没有补丁时**自动拒绝并提示**，默认的 `/load <n>`（注入上下文）照常可用
4. 会话日志格式从 v0 变 v4：旧会话不会被自动迁移，`/sessions` 只列得出现在能读的会话

### 连定时问候一起装

```bash
./install.sh --with-cron
```

### 自定义路径

```bash
DSH_HOME=/path/to/.dsh ./install.sh
```

---

## 使用

> **关于 token 相关命令**：`/token` 会优先查官方用量与余额，需要你在
> `$DSH_HOME/.credentials.yaml` 里提供 `DEEPSEEK_USER_TOKEN`（可选）。
> **首次使用不强制绑定**——没配也能用，只是退化成「仅本地统计」，命令会明确提示。


### 人设（11 套，可切换）

```
你：/persona            ← 列出全部人设（编号 + 简介）
你：/persona 3          ← 切到第 3 套
你：/persona maid       ← 也可用 id 切
你：/persona off        ← 关掉，恢复普通口吻
你：/whale               ← 老入口仍可用（等于切回鲸鱼娘）
你：/normal             ← 老入口仍可用（等于关闭）
```

- **人设是「粘住」的**：开了之后，后续每个 `/new` 出来的会话都会自动继承；关掉要用 `/persona off`（或 `/normal`）。
- 人设文案与列表在 `src/personas.mjs`（公开版共 11 套），改完跑 `sync-version.sh` 即生效。
- 新版本还支持 `/style`：早间定时问候按 `auto`（跟随当前人设）/ `random`（全员随机）/ 指定人设 发。

### 用量与余额

> **可选的官方数据**：官方用量/余额查询需要 `DEEPSEEK_USER_TOKEN`（放在
> `$DSH_HOME/.credentials.yaml` 里，602/600 权限）。**不绑定也能用**——
> `/token` 会退化成「仅本地统计」并在输出里明确标注；绑不绑由你决定，本插件不会强求。


```
你：/token

【本次会话】
  请求 12 次 / 轮次 5
  输入 12,345（缓存 6,789 / 新增 5,556）
  输出 678（其中推理 123）
  合计 13,023 · 缓存命中率 55.0%
  估算花费 $0.0012

【今日累计】3 个会话
  输入 1,234,567（缓存 1,111,111 / 新增 123,456）
  输出 8,901（其中推理 4,567）
  合计 1,243,468 · 缓存命中率 90.0%
  估算花费 $0.02（按 v4-flash 价目，USD）

【账户余额】
  可用 ¥100.00（CNY）
  充值 ¥100.00 / 赠送 ¥0.00
  账户状态：正常

（以上为示例数据）
```

余额来自 `GET https://api.deepseek.com/user/balance`（只读，不消耗 token）。
花费是**估算**，价目取自 pi-ai 内置的 `deepseek-v4-flash` 目录。

### 历史对话

```
你：/sessions
🤖：最近的对话（共 3 个，显示最新 3 个）

    [1] 项目讨论 ← 当前
         刚刚 · 22 条提问
    [2] 定时问候配置
         2 小时前 · 8 条提问

    用 /load <编号> 把该对话的上下文载入当前会话。
```

**`/load` 是「载入上下文」，不是「切换会话」** —— 会话 id 不变，只是把旧对话内容注入进来。
想干净开局就 `/new` 后再 `/load`。

为什么不实现真切换，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#七为什么不做真正的会话切换)。

### 定时问候

两种文风，默认 50/50 随机：

**朝堂风**
> 皇上吉祥。今日 10月21日，行至周中，课业过半。
>
> 半程最易倦，能至此已是本事；再进一寸，前路便短一寸。

**鲸鱼娘风**
> 主人好呀～今日 10月21日，一周过了一半，课业也过半了呢喵。
>
> 走到半路最容易累……哼，能撑到这里已经是本事了啦，再挪一寸，前面就短一寸哦。

固定其中一版：`/style whale`、`/style imperial`、`/style random`。

改文案：编辑 `~/.dsh/.whale-commands/greetings/morning.sh` 里的 `case` 段。

本地预览不发送：

```bash
DRY_RUN=1 bash ~/.dsh/.whale-commands/greetings/morning.sh
DRY_RUN=1 FORCE_DOW=3 FORCE_STYLE=whale bash ~/.dsh/.whale-commands/greetings/morning.sh
```

### 从菜单里隐藏别的插件的命令

同一宿主上如果还有**其它插件**注册了斜杠命令，`/help` 会把它们归进「扩展命令」组。
不想让它们出现在菜单里（比如只对你自己有意义的那几条），就在
`~/.dsh/.whale-commands/hidden.commands` 里一行写一个命令名：

```
# 注释行
example-a
example-b
```

- **只影响菜单展示，命令本身照常可用**
- 文件不存在＝不过滤；读不到也当空集，不影响启动
- 这份名单只在本机状态目录里，不属于仓库；插件代码里不含任何具体命令名

---

## 改代码后必须做的一步

插件靠 `cordis.patch.yml` 里的 `config.version` 触发重载。**改了代码不升版本 = 改了不生效，且不报错。**

本项目用「内容指纹」消除这个隐患：

```bash
~/.dsh/profiles/web/plugins/whale-commands/sync-version.sh
```

它把代码内容的 sha256 前 8 位写进版本号：

```
version: '1.0.0+687c4e82'
         └──┬──┘ └────┬───┘
          语义版本    内容指纹（改一个字节就变）
```

检查是否已同步（适合放进提交前检查）：

```bash
sync-version.sh --check    # 不一致则退出码 1
```

语义版本的档位仍需人判断：

| 档位 | 何时升 |
|---|---|
| **major** | 破坏性变更：配置结构变、命令被移除 |
| **minor** | 新增功能，向后兼容 |
| **patch** | 修 bug，不改接口 |

```bash
sync-version.sh --bump minor    # 先手升基线，再同步指纹
```

### 提交前自检

仓库自带一个通用扫描脚本（规则里不写死任何用户名/主机名/业务词）：

```bash
./scripts/scan-secrets.sh              # 扫已跟踪文件 + git 历史
./scripts/scan-secrets.sh --worktree   # 只扫工作树
```

它会拦三类东西：密钥/凭据形态、某个用户 home 下的绝对路径、以及不该被跟踪的
凭据类文件（`.env` / `*.pem` / `*.key`）。有命中退出码 1，可以直接当 pre-push 钩子：

```bash
ln -sf ../../scripts/scan-secrets.sh .git/hooks/pre-push
```

---

## 卸载

```bash
./uninstall.sh           # 卸载插件和脚本，保留状态与日志
./uninstall.sh --purge   # 连状态和日志一起删
```

插件会被热卸载（从 `cordis.patch.yml` 移除挂载段即可），不用重启。

---

## 故障排查

| 症状 | 排查 |
|---|---|
| `/help` 回「未知命令」 | 插件没挂上。看 `~/.dsh/.whale-commands/plugin.log` |
| 日志里 `apply done: ok=8` | 注册成功，说明问题在别处 |
| 日志里 `ok=0` 或 `register FAILED` | 命令名冲突。重挂一次即可（自愈重试通常已处理） |
| 命令生效但人设没变 | 人设注入下一步，发下一条消息才吃到 |
| `/token` 余额查询失败 | 检查 `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY` |
| 定时问候没收到 | 先 `DRY_RUN=1 bash ~/.dsh/.whale-commands/greetings/morning.sh` 看文风对不对；再看 `greetings.log`。若日志里有 `NODE: unbound variable`，是 1.1.0 及更早的 bug，升级到 1.1.1 |
| Web GUI 里发这几个命令回「只在微信通道可用」 | 预期行为，避免跨通道读微信会话 |
| 升级 0.2 后所有命令都回「执行 Harness 命令时发生错误」 | 通道插件没适配 0.2：`commands.execute` 参数从 3 个变 4 个。见 `patches/` |
| 报 `format v4 message requires a producer-owned source kind` | 某条消息用了 `source.kind="plugin"`（0.2 禁止）。本插件 1.2.0 已修；旧版本需升级 |
| 报 `session ... is already owned by an active write handle` | 同一会话被两个实例/两次写入占用：确认没开第二个 `dsh web`，等几秒重发 |
| 通道插件 `ERR_MODULE_NOT_FOUND: dsh-agent-presets` | 装 `compat/dsh-agent-presets` 垫片 |
| 升级后 `/load --hard` 说「通道未打补丁」 | 正常：先看 `/version`，需要真切换就按 `patches/README.md` 打补丁 |

**这个插件出错不会让服务起不来** —— 入口已加固，失败只会降级成「没有命令」。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | Harness 主目录 |
| `DSH_WHALE_SESSION_PREFIX` | `weixin-` | 只对这些前缀的会话生效 |
| `DSH_WHALE_ZSTD` | `/usr/bin/zstd` | zstd 可执行文件 |
| `DSH_BALANCE_URL` | `https://api.deepseek.com/user/balance` | 余额接口。⚠️ 改成别的域名＝把 `DEEPSEEK_API_KEY` 发给那个域名 |
| `DSH_WEIXIN_CRED_FILE` | `$DSH_HOME/.credentials.yaml` | 凭据文件（旧名 `WEIXIN_CRED_FILE` 仍兼容） |
| `DSH_WEIXIN_CRED_KEY` | `WEIXIN_ILINK_CREDENTIAL` | 凭据键名 |
| `DSH_WEIXIN_TO_USER` | 凭据内 `userId` | 覆盖推送收件人 |

---

---

## 兼容性：harness 0.1 与 0.2

本插件**一份代码同时支持两个版本**，差异只在「真切换会话」这一项：

| harness | 插件本体 | 通道补丁 | `/load <n>` | `/load <n> --hard` |
|---|---|---|---|---|
| 0.1.x（rc.7） | ✅ 直接可用 | 可选 | 注入上下文 | 打补丁后可用 |
| 0.2.x | ✅ 直接可用 | **建议打** | 注入上下文 | 打补丁后可用 |

发 `/version` 可自诊断：会告诉你当前通道是否已打「真切换」补丁。

### 让 0.1 时代的通道插件跑在 0.2 上

0.2 移除了 `@deepseek-ai/dsh-agent-presets` 包，导致一批为 0.1 写的通道插件（`lark` / `qqbot` / `wecom` / `agentchat` / `weixin`）
在 0.2 上 `ERR_MODULE_NOT_FOUND`。仓库提供两样东西：

1. **兼容垫片** `compat/dsh-agent-presets/`：补回插件仍在使用的 `resolveSessionPreset`，装进 profile 的 `node_modules` 即可
2. **通道补丁** `patches/`：说明 0.2 与 0.1 的 8 处 API/格式差异，并给出可直接套用的补丁

> 注意：补丁作用于第三方插件 `deepseek-harness-weixin`（MIT），请遵守其许可证并在你自己部署内使用。

## 兼容性（原章节）

- 在 **DeepSeek Harness `0.1.0-rc.7`** + **deepseek-harness-weixin `0.2.5`** 上验证通过
- 依赖 Harness 的 internal API（`ctx.commands.register`、`agent.inject`、`agent/created`），跨大版本可能需要适配
- **命令是全局注册的**（普通 ctx 注册即全局），所以 Web GUI 里也能看到这些命令入口；
  但 `/whale`、`/normal`、`/sessions`、`/load`、`/style`、`/token` 这 6 条读的是**微信会话数据**，
  在非微信会话（如 Web GUI）会直接返回「只在微信通道可用」，避免跨通道读取。
  `/time`、`/help` 无毒，任何通道都能用
- 人设自动继承（`agent/created`）用 `weixin-` 前缀过滤，只对微信会话生效

## 安全说明

- 插件**不含任何凭据**，运行时从 Harness 自己的凭据文件读取
- 从不打印或返回 token
- 只读取会话日志，不修改
- 除「注入人设」「主动推送」「查余额」外无其它网络请求

## 变更记录

### 1.2.0

- 新增 `/persona` 人设库（11 套）、`/model` 模型切换、`/version` 自诊断
- `/load` 支持 `--hard` 真切换（默认仍为注入上下文，向后兼容）
- **修复**：人设注入消息的来源类型改为生产者名，解决 harness 0.2 的
  `format v4 message requires a producer-owned source kind` 校验失败
- **修复**：全部路径改为跟随 `DSH_HOME`（不再写死 `~/.dsh`），支持自定义 home
- 新增 `compat/` 兼容垫片与 `patches/` 说明，让 0.1 时代的通道插件可在 0.2 上运行
- 文档补充 0.1 → 0.2 的 8 处 API/格式差异与迁移步骤

### 1.1.2

- 新增 `scripts/scan-secrets.sh`：提交前自检（密钥形态 / 本机绝对路径 / 凭据类文件名 / git 历史）
- 文档与示例去掉可能暗示本机私有配置的措辞（`hidden.commands` 示例改成通用名字）
- 清理仓库对象库里两个不可达的历史残留 blob

### 1.1.1

- **修复**：`greetings/morning.sh` 里 `$NODE` 在参数化时漏改成 `$NODE_BIN`，`set -u` 下
  每天 7:00 必然 `unbound variable` 退出、问候一条都发不出去（只在日志里留一行报错）
- **修复**：`/token` 的「今日累计」旧实现按会话文件 mtime 挑文件、再把**整份历史**加总，
  跨天的老会话会把昨天的量算进今天。改为按事件 `time >= 今日零点` 过滤
- **修复**：`/token` 今日扫描只认 `session.jsonl.zstd`，纯 `session.jsonl` 的会话被静默漏掉
- **修复**：`weixin-send.mjs` 注释写「不抛异常」，但 `loadCredential()` 在 `try` 之外，
  凭据缺失会抛给调用方。已挪进 `try`
- **修复**：`install.sh` 版本基线写死 `1.0.0`、且挂载行已存在就整段跳过 ——
  重装新版本时 `version` 不变会导致 Cordis 不重挂（第 11 节事故的同一类问题）。
  现在基线从 `package.json` 读，已挂载时改跑 `sync-version.sh`
- **改进**：README 里 `DSH_WEIXIN_CRED_FILE` / `DSH_WEIXIN_CRED_KEY` / `DSH_WEIXIN_TO_USER`
  三个变量此前只在文档里存在，现已真正实现
- **改进**：注入消息带上语义 `form`（人设 `instructions`、历史载入 `recall`），宿主会折叠展示
- **改进**：`install.sh` 增加 `bash -n` 自检、node 可执行性检查、cron 行引号与路径校验
- **新增**：`hidden.commands` 菜单隐藏名单（机制通用、不含任何具体命令名），
  可让同一宿主上其它插件的命令不出现在 `/help` 里
- **改进**：`.gitignore` 覆盖 `.credentials.yaml` / `.env` / `*.pem` / `*.key` / `sessions/`
- **修复**：`scripts/sync-version.sh` 提示里残留的开发机日志路径

### 1.1.0

- `/help` 改为两级菜单：`/help` 出分组目录，`/help <group>` 进子菜单（支持首字母简写），`/help all` 一次列全


## License

本项目采用 **AGPL-3.0** 许可。协议全文见 [LICENSE](LICENSE)。

> 简单说：你可以自由使用、修改、分发，但如果修改后对外提供服务，源码也必须公开。
