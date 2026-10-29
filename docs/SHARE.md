# /share —— 临时下载链接

微信单文件上限 30MB（大文件传 CDN 还常 500）。`/share` 用一条**限时 + 带令牌的 HTTPS 直链**绕开它：
手机点开就能下，链接到期或次数用尽自动失效。

实现是一个独立工具 `tools/share-file.mjs`（零依赖纯 Node）+ 一层很薄的命令壳。

## 组成

```
tools/share-file.mjs          独立 CLI 工具（add / list / stop / status / daemon）
       ↓ 被调用
常驻 daemon  127.0.0.1:8796   只监听本机，对外由你自己的 HTTPS 反代转发
状态文件     <DSH_HOME>/.share-file/shares.json
访问日志     <DSH_HOME>/.share-file/access.log（不记令牌）
```

## 安装

### 方式一：跟着插件走（推荐）

`install.sh` 会把 `tools/share-file.mjs` 一起复制到插件目录，装完即可用：

```bash
./install.sh
```

### 方式二：只想用工具，不装插件

```bash
cp tools/share-file.mjs ~/.dsh/tools/
node ~/.dsh/tools/share-file.mjs add ./报告.pdf
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 工作区主目录；状态文件放它下面 |
| `SHARE_STATE_DIR` | `<DSH_HOME>/.share-file` | 状态与日志目录 |
| `SHARE_PORT` | `8796` | daemon 监听端口（只绑 127.0.0.1） |
| `SHARE_PUBLIC_BASE` | `http://127.0.0.1:<port>` | **对外链接前缀**，见下 |

### 对外链接怎么配

**不配 `SHARE_PUBLIC_BASE`**：生成的链接是 `http://127.0.0.1:8796/<token>/<文件>`，**只有本机能打开**——适合本地调试，或你只在一台机器上用。

**配了**：链接就是 `https://你的域名/s/<token>/<文件>`，手机能直接下。

Caddy 示例：

```caddy
example.com {
    handle_path /s/* {
        reverse_proxy 127.0.0.1:8796
    }
}
```

```bash
export SHARE_PUBLIC_BASE=https://example.com/s
```

Nginx 示例：

```nginx
location /s/ {
    proxy_pass http://127.0.0.1:8796/;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

> 反代必须**剥掉 `/s` 前缀**：daemon 只认 `/<token>/<文件名>` 两段路径。

## CLI

```bash
node tools/share-file.mjs add <文件> [--ttl 30] [--max-downloads 3] [--name 显示名]
node tools/share-file.mjs list [--json]
node tools/share-file.mjs stop <id|all>
node tools/share-file.mjs status
node tools/share-file.mjs daemon [--port 8796]
```

- `add` 会自动拉起 daemon，不用手工常驻
- 同一文件重复 `add` 会复用未过期的链接
- daemon 空闲 15 分钟自动退出

## 微信命令

```
/share <文件>            分享（默认 30 分钟 / 3 次）
/share <文件> 120 5      自定义：120 分钟 / 5 次
/share list              看进行中的分享
/share stop <id>         立刻停掉某条（链接马上失效）
/share stop all          全部停掉
/share status            服务状态
```

命令壳只做参数解析和输出格式化，真正的逻辑都在 `tools/share-file.mjs` 里。

## 安全模型

**为什么链接猜不到**：令牌是 `randomBytes(32)` 的 base64url，256 位熵，和文件路径、内容、时间没有任何关联。枚举的空间是 2^256，反查也没有入口——**从机制推不出链接**。

真正的防线是这几条（缺一不可）：

1. **一条分享只对应一个文件**：路径来自命令行显式指定，绝不拼接用户输入
2. **未知令牌一律 404**：不区分"不存在"和"没权限"，不给枚举者任何信号
3. **限时**：默认 30 分钟，到期自动删除
4. **限次**：默认 3 次，用尽即失效
5. **只监听 127.0.0.1**：外部必须经过你自己的 HTTPS 反代
6. **只接受 GET / HEAD**，不列目录，响应带 `nosniff` + `attachment`
7. **访问日志不记令牌全文**：只记时间、IP、方法、状态、耗时、UA

所以哪怕链接被转发出去，泄露的范围也被"30 分钟 + 3 次"框死；想让某条立刻失效，`/share stop <id>` 就够。

## 排障

| 现象 | 原因 |
|---|---|
| 链接能生成但手机打不开 | 没配 `SHARE_PUBLIC_BASE`，或者反代没剥 `/s` 前缀 |
| 反代 404 | Caddy 用了 `handle_path /s/*` 但 daemon 没起：`/share status` 看状态 |
| 下载 429 | 这条分享的次数用完了，重新 `/share <文件>` |
| 下载 410 | 源文件被移动或删除 |
| daemon 起不来 | 端口被占：`SHARE_PORT=8899` 换一个 |
| 状态文件权限 | daemon 只跑在本机用户下，别用 root |

日志在 `<DSH_HOME>/.share-file/access.log`，每行一次请求。
