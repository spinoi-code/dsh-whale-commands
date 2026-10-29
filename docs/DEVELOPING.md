# 参与开发（改代码、自检、合并）

> 本插件对「改完不生效」这件事很敏感：命令靠宿主注册表 + Cordis 热挂载，版本号又与内容哈希绑定。
> 这页是改代码之后必须走的流程。

插件靠 `cordis.patch.yml` 里的 `config.version` 触发重载。**改了代码不升版本 = 改了不生效，且不报错。**

本项目用「内容指纹」消除这个隐患：

```bash
~/.dsh/profiles/web/plugins/whale-commands/sync-version.sh
```

它把代码内容的 sha256 前 8 位写进版本号：

```
version: '1.4.0+a1b2c3d4'
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

### 提交前自检

仓库自带一个通用扫描脚本（规则里不写死任何用户名/主机名/业务词）：

```bash
./scripts/scan-secrets.sh              # 扫已跟踪文件 + git 历史
./scripts/scan-secrets.sh --worktree   # 只扫工作树
```

它会拦三类东西：密钥/凭据形态、某个用户 home 下的绝对路径、以及不该被跟踪的
凭据类文件（`.env` / `*.pem` / `*.key`）。有命中退出码 1，可以直接当 pre-push 钩子：

```bash
ln -sf ../../scripts/scan-secrets.sh .git/hooks/pre-push
```

---

---

← 返回 [README](../README.md)
