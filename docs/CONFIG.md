# 环境变量与状态文件

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
| `SHARE_PUBLIC_BASE` | `http://127.0.0.1:<port>` | `/share` 对外链接前缀，如 `https://example.com/s`；不设只有本机能打开 |
| `SHARE_PORT` | `8796` | `/share` daemon 端口（只绑 127.0.0.1） |
| `SHARE_STATE_DIR` | `$DSH_HOME/.share-file` | 分享状态与访问日志目录 |

---

---

---

← 返回 [README](../README.md)
