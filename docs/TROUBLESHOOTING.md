# 故障排查

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

---

← 返回 [README](../README.md)
