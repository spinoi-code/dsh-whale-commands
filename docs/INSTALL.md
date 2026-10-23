# 安装与升级

> 最短路径在 README 的「快速开始」。这页讲细的：不同 harness 版本、定时问候、自定义路径、升级与更新。

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


## 卸载

```bash
./uninstall.sh           # 卸载插件和脚本，保留状态与日志
./uninstall.sh --purge   # 连状态和日志一起删
```

插件会被热卸载（从 `cordis.patch.yml` 移除挂载段即可），不用重启。

---

## 给 AI 助手 / 自动部署的判断规则

按下面三条判断即可：

1. **看 harness 版本**
   - `0.1.x`（rc.7 一系）→ 用 v1.2.0（已实测）
   - `0.2.x` → 用 v1.2.0（1.1.x 会在命令执行、会话写入等处失败，且已不再维护）
2. **0.2 上还要做两件可选的事**
   - 若同时使用 `lark / qqbot / wecom / agentchat / weixin` 等 0.1 时代的通道插件 →
     装 `compat/dsh-agent-presets` 垫片（否则 `ERR_MODULE_NOT_FOUND`）
   - 想要 `/load <n> --hard` 真切换 → 按 `patches/README.md` 给通道插件打补丁
3. **升级后必做**：`sync-version.sh` 同步版本号 → 重启 `dsh web`（否则改动不生效）

> 从 1.1.x 升上来的话：1.2.0 新增 `/persona`（11 套人设）、`/model`、`/version`；
> 老入口 `/whale`、`/normal` **仍然可用**，已有脚本不用改。

---

---

← 返回 [README](../README.md)