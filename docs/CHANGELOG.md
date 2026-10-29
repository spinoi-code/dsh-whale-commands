# 变更记录

## 1.3.0

- **`/search` 深度调研搜索**（本轮核心）：多轮查询 + 抓正文 + 会话模型写成事实概述。
  - `deep`：先用模型判断查询时效窗口（1d/3d/7d/30d/any），规划中英混合查询，再从第一轮结果里
    抽 2~3 个实体关键词补搜一层（**最多 2 层，无递归**）。
  - `brief`：只要找到的资料，不做概述。
  - `en`：英文关键词。
  - 时效过滤：窗口内资料不足 3 条时按 1d→3d→7d→30d 逐级放宽（纯本地筛选，不重搜）；
    概述与参考来源共用同一批过滤后的资料，不会出现"概述用新的、链接列旧的"。
  - 输出结构化：概述 → 分界线 → 参考来源（带日期）；微信纯文本，自动剥离 markdown 记号。
  - 数据通路复用宿主服务：`ctx.web.search` / `ctx.web.fetch` / `ctx.llm.stream`。

## 1.2.0

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

---

← 返回 [README](../README.md)
