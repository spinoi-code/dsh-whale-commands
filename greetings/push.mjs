#!/usr/bin/env node
/**
 * 命令行推送入口：node push.mjs "要发送的文字"
 *
 * 供 morning.sh 及任何脚本调用。凭据读取见同目录 weixin-send.mjs（安装时一并复制）。
 * 成功退出 0，失败退出非 0，输出单行 JSON（不含任何凭据）。
 */
import { sendText } from "./weixin-send.mjs";

const text = process.argv[2];
if (typeof text !== "string" || text.trim() === "") {
  console.error('用法: node push.mjs "要发送的文字"');
  process.exit(2);
}

const result = await sendText(text);
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
