# 兼容垫片（main 分支说明）

本目录的**完整内容在 `feat/harness-0.2` 分支**（v1.2.0）：

- `compat/dsh-agent-presets/` —— 让 0.1 时代的通道插件（lark / qqbot / wecom / agentchat / weixin）
  在 harness 0.2 上通过模块加载（0.2 移除了该包）

获取方式：

```bash
git show feat/harness-0.2:compat/README.md
# 或直接切分支
git checkout feat/harness-0.2
```

装法：把 `dsh-agent-presets/` 整个目录复制到 `$DSH_HOME/profiles/web/node_modules/@deepseek-ai/` 下。
