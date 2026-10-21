# dsh-whale-commands 🐋

一个给 **DeepSeek Harness 微信通道**用的扩展命令插件。

装上之后，你可以在微信里发斜杠命令直接控制 Harness 会话：切换人设、翻历史对话、
查 token 用量和账户余额、设置每天早上的定时问候。

**命令由宿主进程直接执行，不经过模型。** 所以它们不消耗 token、结果确定、响应即时，
适合放控制类操作。插件同时支持热挂载：改配置或代码后不需要重启 `dsh web`。

![status](https://img.shields.io/badge/status-可用-brightgreen)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.7-blue)
![license](https://img.shields.io/badge/license-AGPL--3.0-blue)

---

## 目录

- [命令一览](#命令一览)
- [技术要点](#技术要点)
- [安装](#安装)
- [使用](#使用)：[人设](#人设) · [用量与余额](#用量与余额) · [历史对话](#历史对话) · [定时问候](#定时问候)
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
| `/load <编号>` | 把该对话最近上下文载入当前会话 |
| `/time` | 当前服务器时间 |
| `/token` | 本会话用量 + 今日累计 + 账户余额 |
| `/style` | 设置早间问候风格 |
| `/help` | 动态列出全部命令 |

外加**定时问候**：每天 7:00 推一条「请安 + 鼓励」，两种文风 50% 随机。

---

## 技术要点

实现过程中处理了几个 Harness 里不太直观的机制，如果你也在写 DSH 插件，这几点可以直接参考：

1. **不重启就能加命令** —— 命令注册表运行时可增，微信桥会派发任何已注册命令；改 `cordis.patch.yml` 会被 Cordis HMR 热加载。
2. **人设跨 `/new`** —— 监听 `agent/created`，新会话自动继承。
3. **注入但不打扰** —— 用 `agent.inject()` 而不是 `followup()`：只把上下文排进下一步，不凭空多开一轮对话。
4. **机器人能主动找你** —— iLink 的 `context_token` 是可选字段，所以没有入站消息也能推送。
5. **重挂不会把命令弄丢** —— 进程级注册去重 + 自愈重试（这条是踩坑踩出来的，见下）。
6. **版本号与内容强绑定** —— 内容哈希写进 `config.version`，杜绝「改了代码但没生效」。
7. **`/help` 按宿主注册表自动分组** —— 命令表越大越长，所以 `/help` 只出目录（按用途分组），`/help <group>` 进子菜单看细节，`/help all` 一次列全。分组从 `ctx.commands.list()` 动态推导，装了别的插件也会自动归位；`description` 里带换行的命令，子菜单会缩进展开成多行说明。

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

装完等几秒（Cordis HMR 自动挂载），在微信里发 `/help` 验证。

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

### 人设

```
你：/whale
🤖：鲸鱼娘模式已开启喵～本小姐这就在了。
你：今天写点什么好
🤖：哼，笨蛋主人，本鲸鱼娘陪你一起想嘛～（摇尾巴）
```

**人设是「粘住」的**：开了之后，以后每个 `/new` 出来的会话都会自动继承。想彻底关掉得发 `/normal`。

改人设文案：编辑 `~/.dsh/profiles/web/plugins/whale-commands/impl.mjs` 里的 `PERSONA` 常量，
然后跑 `sync-version.sh`（见下文）。

### 用量与余额

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
| 定时问候没收到 | `tail ~/.dsh/.whale-commands/greetings.log`；无记录说明 cron 没跑 |

**这个插件出错不会让服务起不来** —— 入口已加固，失败只会降级成「没有命令」。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | Harness 主目录 |
| `DSH_WHALE_SESSION_PREFIX` | `weixin-` | 只对这些前缀的会话生效 |
| `DSH_WHALE_ZSTD` | `/usr/bin/zstd` | zstd 可执行文件 |
| `DSH_BALANCE_URL` | `https://api.deepseek.com/user/balance` | 余额接口 |
| `DSH_WEIXIN_CRED_FILE` | `$DSH_HOME/.credentials.yaml` | 凭据文件 |
| `DSH_WEIXIN_CRED_KEY` | `WEIXIN_ILINK_CREDENTIAL` | 凭据键名 |
| `DSH_WEIXIN_TO_USER` | 凭据内 `userId` | 覆盖推送收件人 |

---

## 兼容性

- 在 **DeepSeek Harness `0.1.0-rc.7`** + **deepseek-harness-weixin `0.2.5`** 上验证通过
- 依赖 Harness 的 internal API（`ctx.commands.register`、`agent.inject`、`agent/created`），跨大版本可能需要适配
- 只对微信通道生效；Web GUI 会话不受影响（前缀过滤）

## 安全说明

- 插件**不含任何凭据**，运行时从 Harness 自己的凭据文件读取
- 从不打印或返回 token
- 只读取会话日志，不修改
- 除「注入人设」「主动推送」「查余额」外无其它网络请求

## License

本项目采用 **AGPL-3.0** 许可。协议全文见 [LICENSE](LICENSE)。

> 简单说：你可以自由使用、修改、分发，但如果修改后对外提供服务，源码也必须公开。
