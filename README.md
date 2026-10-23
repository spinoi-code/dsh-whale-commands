# dsh-whale-commands 🐋

一个给 **DeepSeek Harness 微信通道**用的扩展命令插件。

装上之后，在微信里发斜杠命令就能直接控制 Harness 会话：**在各套人设之间切换**、
翻历史对话（注入上下文，或**真切换会话**）、切换模型、查 token 用量与余额、设置每天的定时问候。

**命令由宿主进程直接执行，不经过模型** —— 不消耗 token、结果确定、响应即时。
插件支持热挂载：改配置或代码后不需要重启 `dsh web`。

> **微信那个通道插件（`deepseek-harness-weixin`）原本跑不了 harness 0.2，我们把它修好了**：
> 0.1 改到 0.2 时一批 API 换了写法，我们给这个通道插件重写了会话读取与命令执行，
> 补了 **8 类 API 适配 + 7 项稳定性修复**，还做了个垫片让 `lark` / `qqbot` / `wecom` 这些老通道插件也能在新版上加载。
> 本插件本身两边通吃，0.1.x / 0.2.x 装哪边都行 → [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)

![status](https://img.shields.io/badge/status-可用-brightgreen)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.1%20%7C%200.2-blue)
![version](https://img.shields.io/badge/version-1.2.0-orange)
![license](https://img.shields.io/badge/license-AGPL--3.0-blue)

## 特性

- **人设库（11 套）** —— `/persona` 随时切换、跨 `/new` 自动继承；只改口吻，不影响准确性
- **历史对话** —— `/sessions` 看最近对话，`/load` 注入上下文，`--hard` 连会话一起切过去
- **用量与余额** —— `/token` 看本会话 token、官方花费与账户余额（不绑令牌也能用本地统计）
- **定时问候** —— 每天早上推一条「请安 + 鼓励」，口吻跟随当前人设，或按 `/style` 指定
- **一份代码两个 harness** —— 0.1.x 与 0.2.x 通用，附 0.2 兼容补丁与垫片
- **零 token 成本** —— 命令走宿主注册表，不额外调模型

## 快速开始

> ⚠️ **先装微信通道插件，再装本插件。**
> 本插件是「微信通道的扩展命令」——它只负责在微信里提供斜杠命令，
> 聊天收发本身由通道插件 `deepseek-harness-weixin` 负责。
> **漏装通道插件不会让 dsh 崩**，但你会看到「装好了却什么都不能用」：
> `/sessions` 说没有对话、人设也没对象可注入。
>
> ```bash
> # 顺序参考：先通道，后本插件
> dsh plugin --profile web add deepseek-harness-weixin
> dsh plugin --profile web add dsh-whale-commands
> ```
> 装完重启一次 `dsh web`，并用微信给机器人发一句话（有入站消息才会建会话）。

一条命令，装完即挂载（本包已声明 `dsh.bundle`，不需要再手改 profile）：

```bash
dsh plugin --profile web add dsh-whale-commands
```

如果还想顺带装好「早间问候脚本 + 自检」，用仓库里的安装脚本（两种方式**二选一**，别同时用）：

```bash
git clone https://github.com/spinoi-code/dsh-whale-commands.git
cd dsh-whale-commands && ./install.sh
```

装完重启一次 `dsh web`，在微信里依次发 `/version`、`/help`、`/persona` 确认。

前置条件：已跑过 `dsh web`（会生成 `~/.dsh/profiles/web/`）、微信通道已配置、Node.js ≥ 22、
`zstd` 可用（读会话历史需要）。

## 命令一览

| 命令 | 作用 |
|---|---|
| `/persona [编号\|id\|off]` | **人设库（11 套）**：切换 / 关闭 / 查看 |
| `/whale` | 切回「鲸鱼娘·大肥鱼」人设（**纪念版专属命令**，原样保留） |
| `/normal` | 关闭人设，恢复普通口吻 |
| `/sessions` | 列出最近 5 个对话（标题、时间、提问数） |
| `/load <编号>` | 把该对话最近上下文载入当前会话 |
| `/load <编号> --hard` | **真切换**到该对话（需通道补丁） |
| `/model [模型\|default ...]` | 切换本会话模型、设置 `/new` 默认模型 |
| `/token` | 本会话用量 + 今日累计 + 账户余额 |
| `/style [auto\|random\|imperial\|<人设id>]` | 早间问候风格 |
| `/version` | 插件版本 + 通道补丁自诊断 |
| `/time` | 当前服务器时间 |
| `/help [组\|all]` | 分组菜单（talk / model / role / ext / harness） |

详细的用法、输出样例与边界 → [docs/COMMANDS.md](docs/COMMANDS.md)

## 人设与定时问候

人设库共 **11 套**（鲸鱼娘、女仆、机娘、魔女、古风王爷……），`/persona` 里可以看全表。
早间问候的文案就写在每个人设里，口吻自动跟随；想让每天不重样，用 `/style random`。

> `/whale` 和 `/normal` 是**为纪念保留**的原始入口：插件最早只有「鲸鱼娘开关」这一个功能，
> 后来才扩成人设库。这两个命令保持一字未改，老脚本不用动。

细节 → [docs/PERSONAS.md](docs/PERSONAS.md) · [docs/GREETINGS.md](docs/GREETINGS.md)

## 兼容性

**同一份代码同时支持 harness 0.1.x 与 0.2.x**，差别只在「真切换会话」需要给微信通道插件打补丁。

本项目还修复了 `deepseek-harness-weixin` 在 0.2 上的 **15 项兼容问题**（8 类 API + 7 项稳定性），
并提供垫片让 `lark` / `qqbot` / `wecom` / `agentchat` 等 0.1 时代的通道插件也能在 0.2 上加载。

完整差异表、补丁用法与排查方法论 → [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 安装细节：harness 版本选择、自定义路径、升级与更新 |
| [docs/COMMANDS.md](docs/COMMANDS.md) | 每条命令的用法、输出与限制 |
| [docs/PERSONAS.md](docs/PERSONAS.md) | 人设库与 `/whale` 纪念入口 |
| [docs/GREETINGS.md](docs/GREETINGS.md) | 定时问候：文案来源、`/style`、本地预览 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | 0.1 ↔ 0.2 兼容清单、垫片与通道补丁 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 实现原理与踩坑记录（写给插件作者） |
| [docs/DEVELOPING.md](docs/DEVELOPING.md) | 改代码后必做的那一步、提交前自检 |
| [docs/CONFIG.md](docs/CONFIG.md) | 环境变量与状态文件 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 故障排查 |
| [docs/SECURITY.md](docs/SECURITY.md) | 安全说明：碰什么、不碰什么 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 变更记录 |

## 卸载

```bash
./uninstall.sh
```

脚本会移除 profile 里的插件副本与 `cordis.patch.yml` 的挂载段；问候脚本与状态文件
（`~/.dsh/.whale-commands/`）按提示决定是否一起删。详见 [docs/INSTALL.md](docs/INSTALL.md)。

## License

AGPL-3.0。见 [LICENSE](LICENSE)。

> 本项目与 DeepSeek 官方无关，是基于公开 API 的第三方插件。
