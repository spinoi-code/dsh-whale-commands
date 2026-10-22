/**
 * 0.2 兼容垫片（compat shim）
 *
 * dsh 0.2 移除了 `@deepseek-ai/dsh-agent-presets` 包（拆成 dsh-agent-preset + registry），
 * 但 lark / qqbot / wecom / agentchat / weixin 五个通道插件仍从它导入 resolveSessionPreset。
 * 这里按 rc.7 原实现等价补回：倒序找最后一条 agent-preset/selected 事件，回退 header.agentPreset。
 */
export function resolveSessionPreset(session) {
  const events = (session && session.events) || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'agent-preset/selected') return event.data.agentPreset;
  }
  return session && session.header ? session.header.agentPreset : undefined;
}

export default { resolveSessionPreset };
