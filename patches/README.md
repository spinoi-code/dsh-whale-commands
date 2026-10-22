# harness 0.1 → 0.2：通道插件适配补丁

本目录记录把 **0.1 时代**的微信通道插件（`deepseek-harness-weixin@0.2.5`，MIT）跑到 **harness 0.2** 上的全部差异。
`weixin-harness-0.2.diff` 是相对 npm 原版 `dist/index.js` 的统一 diff，可直接 `patch -p0`。

> 用途仅限**你自己部署的实例**；请遵守上游插件许可证，不要分发上游代码。

## 8 处差异（逐条对应）

| # | 0.1 写法 | 0.2 的变化 | 补丁怎么处理 |
|:--|:--|:--|:--|
| 1 | `agentCtx.agent` | 需 inject 声明才可读 | try/catch 取值 + 会话兜底，取不到就跳过设权限 |
| 2 | `commands.execute(agent, line, signal)` | 变成 4 参：`(agent, line, submittedAttachments, signal)` | 按 `.length >= 4` 自适应传参 |
| 3 | 附件参数可省略 | 传 `undefined` 时读 `.length` 抛错 | 传空数组 `[]` |
| 4 | `sessionPersistence.inspect()` | **已删除**（只剩 `open/list/stat`） | 「有则用，无则用配置默认预设」 |
| 5 | `session.events` | 变私有，公开接口 `snapshotEvents()` | `sessionEventsOf()` 兼容层 |
| 6 | `sessionPersistence.list()` → `{id}` | 变成 `{header:{id}}` | 兼容读 `item.header.id ?? item.id` |
| 7 | `attachments.saveImage/readImage` | 改名 `saveImages/readImageRequest` | 兼容封装 |
| 8 | 消息 `source.kind = "plugin"` | **v4 会话格式明令拒绝** | 注入消息改用生产者名（如 `weixin-channel`） |

## 应用方式

```bash
# 1) 备份
cp ~/.dsh/profiles/web/node_modules/deepseek-harness-weixin/dist/index.js{,.bak}

# 2) 套补丁
cd ~/.dsh/profiles/web/node_modules/deepseek-harness-weixin
patch -p0 dist/index.js < /path/to/weixin-harness-0.2.diff

# 3) 语法自检 + 重启
node --check dist/index.js && sudo systemctl restart deepseek-harness
```

## 通用套路（换别的 0.1 插件也能用）

1. 先看加载错误：`ERR_MODULE_NOT_FOUND` → 先补 `compat/dsh-agent-presets` 垫片
2. 能加载但命令报错 → 抓真实堆栈（把插件的兜底 catch 改成记录 error.stack）
3. 对照上表逐项排查；`source.kind="plugin"` 是最隐蔽的一条，只在**写会话**时才炸
4. 改完一定要 `node --check`，再用「伪造入站消息」的自检方式跑一遍（否则只能靠用户报障）

## 另有 7 项稳定性 / 隔离修复（同样在 diff 里）

| # | 问题 | 修法 |
|:--|:--|:--|
| 9 | `resolveSessionPreset` 来自 0.2 已移除的包 | dist 内联等价实现 |
| 10 | `@deepseek-ai/dsh-credentials-local` 静态 import，被 pnpm 装成 0.1 版本 → 0.2 判不兼容并禁用 | 改成惰性动态 import，并从依赖里摘掉 |
| 11 | 状态目录写死 `~/.dsh/weixin/`，多实例（影子/生产）会互相污染 | 改为跟随 `DSH_HOME` |
| 12 | 会话在磁盘上已存在但初始化快照没收录 → `create` 抛 `SessionAlreadyExists` | 捕获后自动改走 `resume` |
| 13 | `agent.whenIdle()` 签名变化时命令链直接中断 | 调用容错，失败只记日志不阻塞 |
| 14 | 切换目标已在本管理器绑定 → 抢写锁失败 | 视为成功（幂等） |
| 15 | 写锁冲突时只回「请稍后重试」，无从排查 | 明确提示「会话被另一个写入占用」 |
