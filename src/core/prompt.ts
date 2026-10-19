/**
 * 提示词拼装（host 半侧，纯逻辑）——碎碎念与对话**共用**同一份。
 *
 * 为什么要单独成文件：这里有一条**很容易被无意识破坏的硬约束**——
 *
 *   **system 必须跨请求逐字相同。**
 *
 * 它是 prompt cache（DeepSeek 上下文缓存 / 各家的 prefix cache）唯一能命中的前缀。把任何
 * 「每次都会变」的内容拼进 system，缓存就从变化点开始失效：碎碎念只能命中第一个 64 token
 * 的块，**对话则连整段记忆历史都命中不了**（历史排在 system 之后，前缀一断，后面全部按新
 * 输入计费）。改造前 system 末尾就挂着这样一行：`【当下】现在是…14:31…`（精确到分钟），
 * 于是每 5 分钟一次的碎碎念、每一轮对话都在同一个位置把缓存打断——缓存看起来支持、实际
 * 几乎拿不到。
 *
 * 所以分工写死：
 *   - `petSystemPrompt`：人设 + 名字声明，**不含任何随时间变化的内容**；
 *   - `withTimeContext`：时间背景拼到**最后一条 user 消息**上（易变内容只能待在这里）。
 *
 * 两个函数都不读时钟（now 由调用方传入），边界才能在测试里钉死。
 */
import { findPetInstance } from './config';
import { timeContextOf } from './time-context';

/**
 * 某只宠物的 system（人设）。
 *
 * @param petId 宠物实例 id
 * @param cfg `readAllConfig` 的成品聚合（字段已填满）
 * @returns 所属条目（文件宠物 → 自己的条目，其余 → main）的 `whisperPrompt` + 一句名字声明。
 *   **逐字稳定**：同一份配置下，任何时刻调用都必须得到同一个字符串（prompt cache 的前缀）。
 */
export function petSystemPrompt(petId: string, cfg: Record<string, Record<string, unknown>>): string {
  const found = findPetInstance(cfg, petId);
  const conf = found ? found.conf : (cfg.main ?? {});
  const prompt = typeof conf.whisperPrompt === 'string' ? conf.whisperPrompt : '';
  const name = found ? String(found.pet.name || found.pet.id || petId) : petId;
  const nameLine = '你的名字是“' + name + '”。';
  return prompt ? prompt + '\n' + nameLine : nameLine;
}

/**
 * 把**时间背景**拼到最后一条 user 消息前面。
 *
 * 放在 user 消息而不是 system：时间精确到分钟，每次请求都不同；它落在 user 一侧时，
 * system（人设）与历史消息构成的前缀仍然逐字一致，缓存照常命中，只有这条新消息按新输入计费。
 * 放在指令**前面**（而不是后面）是为了让用户真正说的话留在末尾——模型对末尾指令更敏感。
 *
 * @param text 原本要发出去的用户文本（碎碎念指令 / 用户这句话）
 * @param now 当前时刻（生产传 new Date()，测试传固定值）
 * @returns 时间行 + 原文；`now` 非法（`timeContextOf` 返回空串）时原样返回 text
 */
export function withTimeContext(text: string, now: Date): string {
  const line = timeContextOf(now);
  return line ? line + '\n' + text : text;
}
