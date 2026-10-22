# 通道插件适配补丁（main 分支说明）

完整内容在 `feat/harness-0.2` 分支（v1.2.0）：

- `patches/weixin-harness-0.2.diff` —— 把 0.1 时代的微信通道插件（`deepseek-harness-weixin@0.2.5`）
  适配到 harness 0.2 的统一 diff（已验证可 `patch -p0` 应用）
- 8 处差异清单与排查方法见该分支的 `patches/README.md`

```bash
git checkout feat/harness-0.2
sed -n '1,80p' patches/README.md
```
