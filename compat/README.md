# 兼容垫片（让 0.1 时代的通道插件跑在 0.2 上）

harness 0.2 移除了 `@deepseek-ai/dsh-agent-presets`（拆成 `dsh-agent-preset` + `dsh-agent-preset-registry`），
但为 0.1 写的通道插件仍然从这里导入 `resolveSessionPreset`，于是加载时报：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-agent-presets'
```

## 用法

把 `dsh-agent-presets/` 整个目录放到**你 profile 的 node_modules** 下：

```bash
cp -r compat/dsh-agent-presets ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-agent-presets
```

然后重挂插件 / 重启 `dsh web`。实测可让 `deepseek-harness-lark`、`-qqbot`、`-wecom`、`-agentchat`、`-weixin`
在 0.2 上**通过模块加载**（各插件仍有自己的依赖与凭据要求）。

> ⚠️ 这是「行为等价」的补丁：`resolveSessionPreset` 按 0.1 语义实现
> （倒序找最后一条 `agent-preset/selected` 事件，回退 `header.agentPreset`）。
> 若上游插件改用了 0.2 的新 API，请以新版插件为准。
