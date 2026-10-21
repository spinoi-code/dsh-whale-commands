/**
 * 鲸鱼娘命令插件 —— 稳定入口（v3：加固 + 失败留痕）
 *
 * 相对 v2 的改动
 *   1. 失败不再只走 ctx.logger（那是看不到的），一律追加写入诊断日志文件
 *   2. 保留「绝不抛错」策略：任何失败都降级成「无命令」，避免 fail-loud 让服务起不来
 *
 * ⚠️ 为什么要加固（背景）
 *   dsh 有 fail-loud 守卫（`dsh-app-boot` 的 `assertEntriesActivated`）：
 *   任何 loader entry「import 失败 / 激活被拒 / 没变 active」，`dsh web` 就报
 *   "fatal load failure" 并 process.exit(1)，systemd 每 5 秒重试 → 崩溃循环。
 *   所以本入口的 apply **绝不允许 reject**。
 *
 * 为什么入口与实现分离
 *   Cordis 用 name（模块路径）判断要不要重新 import，而 Node 的 ESM 模块按路径
 *   缓存。两难：改代码就换文件名（越堆越多）/ 不换文件名（改了不生效）。
 *   解法：入口稳定，实现放 impl.mjs，用 `?v=<version>` 查询串导入 —— Node 把带
 *   不同查询串的同一文件视为不同模块实例。
 *
 * 版本规范（语义化版本 major.minor.patch）
 *   major —— 破坏性变更：配置结构变了、依赖不兼容、命令被移除
 *   minor —— 新增功能：新命令、新参数（向后兼容）
 *   patch —— 修 bug：行为修正，不改接口
 *
 * ⚠️ 铁律：动了插件目录里**任何**文件（入口或实现），都必须把
 *   cordis.patch.yml 里的 config.version 升一档。否则重挂瞬间新旧实例会撞车
 *   （详见使用说明第十一节记录的那次事故）。
 *
 * 注意：本文件（入口）自身被 ESM 缓存，真需要改时必须换文件名并同步改
 * cordis.patch.yml 的 name，**同时跑一次 scripts/sync-version.sh**。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "whale-commands";
export const inject = ["commands"];

/** 实现文件，按优先级尝试。 */
const IMPLEMENTATIONS = ["impl.mjs"];
/** Harness 主目录。 */
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
/** 诊断日志；写失败也绝不影响启动。 */
const LOG_FILE = join(DSH_HOME, ".whale-commands", "plugin.log");

function note(line) {
  try {
    mkdirSync(join(DSH_HOME, ".whale-commands"), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* 日志不可写就放弃记录，绝不能因此抛错 */
  }
}

export async function apply(ctx, config) {
  const version = String(config?.version ?? "0.0.0");
  const failures = [];

  for (const file of IMPLEMENTATIONS) {
    let url;
    try {
      url = new URL(`./${file}?v=${encodeURIComponent(version)}`, import.meta.url);
    } catch (error) {
      failures.push(`${file}: 路径解析失败 (${String(error?.message ?? error)})`);
      continue;
    }

    try {
      const mod = await import(url.href);
      const applyImpl = mod?.apply;
      if (typeof applyImpl !== "function") {
        failures.push(`${file}: 没有导出 apply 函数`);
        continue;
      }
      await applyImpl(ctx, config);
      return;
    } catch (error) {
      failures.push(`${file}: ${String(error?.message ?? error)}`);
    }
  }

  // 全部失败：降级但不抛错。同时写文件 + logger，确保这条失败一定留痕。
  const detail = failures.join(" | ");
  note(`ENTRY FAILED v=${version}: 插件加载失败，已降级为无命令模式（服务照常运行）。原因：${detail}`);
  try {
    ctx?.logger?.error?.(`whale-commands: 插件加载失败，已降级为「无命令」模式。原因：${detail}`);
  } catch {
    /* 忽略 */
  }
}
