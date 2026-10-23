# 定时问候

每天固定时间推一条「请安 + 鼓励」到微信。**口吻跟随人设库**，不再是早期那两种固定文风。

## 口吻从哪来

早间问候的文案真身是 `src/personas.mjs` 里每个人设的 `morning` 字段（11 套 × 7 天 + 兜底）。
脚本 `.whale-commands/greetings/morning.sh` 只负责「选谁 + 发出去」，不持有任何文案 ——
所以**加人设只改 personas.mjs**，shell 不用动。

## 用 `/style` 决定风格

| 设置 | 含义 |
|:--|:--|
| `/style auto` | **默认**。跟随当前人设；人设关着时全员随机 |
| `/style random` | 11 套人设全员随机，每天不重样 |
| `/style imperial` | 固定「朝堂风」 |
| `/style whale` 等 | 固定某一个人设（用 id） |

不带参数发 `/style` 会显示当前设置，并列出可选的 11 套。

## 样例（同一句话，三种口吻）

**朝堂风**

> 皇上吉祥。今日 10月21日，行至周中，课业过半。
>
> 半程最易倦，能至此已是本事；再进一寸，前路便短一寸。

**鲸鱼娘·大肥鱼**

> 主人好呀～今日 10月21日，一周过了一半，课业也过半了呢喵。
>
> 走到半路最容易累……哼，能撑到这里已经是本事了啦，再挪一寸，前面就短一寸哦。

**女仆·砂糖**

> 主人早～{date}，一周已经过半喽。
>
> 走到半程最易累，砂糖给您续杯热的吧？再往前一点，后面的路就轻啦。

## 本地预览（不发送）

```bash
# 干跑：只打印，不推送
DRY_RUN=1 bash ~/.dsh/.whale-commands/greetings/morning.sh

# 预览指定星期 + 指定风格
DRY_RUN=1 FORCE_DOW=3 FORCE_STYLE=whale bash ~/.dsh/.whale-commands/greetings/morning.sh
```

## 装定时任务

定时问候**不会自动装**（涉及 crontab 权限），安装时加参数显式开启：

```bash
./install.sh --with-cron      # 写入每天 7:00 的 crontab
```

自查是否跑过：看 `~/.dsh/.whale-commands/greetings/last-run.log` 末行。

---

← 返回 [README](../README.md)
