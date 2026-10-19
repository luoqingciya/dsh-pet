// 气泡单槽：**显示哪一个**是纯决策，**怎么画**收在这一个渲染函数里。
//
// 为什么要拆：这块逻辑的坑不在画，而在"谁压过谁"——
//   - 终态任务（完成/失败）只活 10s，被事件顶掉就彻底看不到了，所以它不让位；
//   - 但**对话回复**要压过终态任务：那是用户刚问出来的答案，"这一轮搞定啦"只是装饰；
//   - 非终态任务（干活中/等你确认）常驻，让位 10s 零损失，优先级最低。
// 这套优先级在浏览器侧 pet.ts（React，已移出本仓库）里有一份同构实现，从前只能靠"两边都别改错"
// 维持。现在决策抽成纯函数（有单测），两端迟早能共用同一份判断。
//
// 渲染是 DOM 层（第 4 个 DOM 例外，前三个是 menu / chat / score-popup）：只碰传进来的那个元素，
// 不查全局、不读配置，所以能用最小 DOM 桩测（见 bubble.test.ts）。

import type { BalanceBubbleRow } from './balance';
import { MEME_BUBBLE_CLASS } from './whisper';

/** 气泡槽位 */
export type BubbleSlot = 'work' | 'whisper' | 'balance' | 'none';

/** 参与优先级判断的**事实**（都由调用方从自己的状态里算好，这里不读状态） */
export interface BubbleFlags {
  /** 工作气泡有内容（开关开着 且 有文案） */
  work: boolean;
  /** 当前工作状态是终态（success / error） */
  workTerminal: boolean;
  /** 说话气泡有内容（碎碎念 / 命令气泡 / 对话回复） */
  whisper: boolean;
  /** 这条说话是**对话回复**（压过终态任务，见文件头） */
  whisperReply: boolean;
  /** 余额气泡有内容 */
  balance: boolean;
  /** 余额气泡是「不可用」的文字说明（多行，套紧凑变体） */
  balanceCompact: boolean;
}

/** 一次气泡渲染的计划 */
export interface BubblePlan {
  slot: BubbleSlot;
  /**
   * 是否用紧凑变体（`is-whisper`：字号更小、宽度下限更窄、正常换行）。
   * 工作气泡与说话气泡都用它（长文案要能折行）；余额「文字说明」同样用，普通余额不用。
   */
  compact: boolean;
}

/**
 * 单槽优先级决策（纯函数）。
 *
 * 顺序：对话回复 > 终态任务 > 说话 > 余额 > 非终态任务 > 无。
 * 注意"对话回复"那一档单独前置：它同时满足 whisper 与"能压过终态"两个条件，
 * 其余 whisper（周期碎碎念 / 第三方投喂）不带这个标记，维持原优先级。
 */
export function planBubble(f: BubbleFlags): BubblePlan {
  let slot: BubbleSlot;
  if (f.whisper && f.whisperReply) slot = 'whisper';
  else if (f.workTerminal && f.work) slot = 'work';
  else if (f.whisper) slot = 'whisper';
  else if (f.balance) slot = 'balance';
  else if (f.work) slot = 'work';
  else slot = 'none';
  const compact = slot === 'whisper' || slot === 'work' || (slot === 'balance' && f.balanceCompact);
  return { slot, compact };
}

/** 渲染需要的内容（节点由调用方给：配图的素材根/基址两端不同） */
export interface BubbleContent {
  /** 工作气泡文案（slot === 'work' 时用） */
  workText: string | null;
  /** 说话气泡文案（slot === 'whisper' 时用；多行时由 CSS 折行） */
  whisperText: string;
  /** 配图节点（null = 不带图）。由调用方按自己的素材根生成 */
  meme: HTMLElement | null;
  /** 余额行（slot === 'balance' 时用） */
  balanceRows: BalanceBubbleRow[] | null;
}

/** 一行的样式类（两端共用同一套类名，样式在 shared 的 CSS 里） */
const ROW_CLASS = 'pet-bub-row';
const ERROR_CLASS = 'pet-bub-err';
const SUB_CLASS = ROW_CLASS + ' pet-bub-sub';
const TIER_CLASS = 'pet-bub-tier';

/**
 * 把气泡画进 `el`，返回用于排障的标题（隐藏时为空串）。
 *
 * 幂等：每次先清空再重建——气泡内容最多几行，重建比 diff 便宜得多，也不会留下上一槽的残留节点。
 *
 * @param el 气泡根元素
 * @param plan planBubble 的结果
 * @param content 内容
 * @returns 排障用的标题（前 60 字符；空槽时为 ''）
 */
export function renderBubbleInto(el: HTMLElement, plan: BubblePlan, content: BubbleContent): string {
  // 变体类先定：CSS 靠它决定宽度/换行/是否取消 min-width
  el.classList.toggle('is-whisper', plan.compact);
  el.classList.toggle(MEME_BUBBLE_CLASS, !!content.meme);

  if (plan.slot === 'none') {
    // 三者都没有可显示的内容：隐藏（不占位，也就不会挡住任何一层）
    el.classList.remove('is-on');
    return '';
  }

  el.innerHTML = '';
  if (plan.slot === 'work') {
    el.appendChild(row(content.workText ?? ''));
  } else if (plan.slot === 'whisper') {
    // 配图在前：先看图再读话，符合"配图"的阅读顺序
    if (content.meme) el.appendChild(content.meme);
    el.appendChild(row(content.whisperText));
  } else {
    // slot === 'balance' 时 rows 必然非空（planBubble 保证）；判一次是为了把类型收窄写显式
    const rows = content.balanceRows;
    if (!rows || rows.length === 0) return '';
    const hasTier = rows.some((r) => r.role === 'tier');
    if (hasTier) {
      // 单行富余额：余额（峰/谷）¥x —— 档位字单独着色，所以拼一行多个 span
      const line = row('');
      for (const r of rows) {
        const span = document.createElement('span');
        if (r.role === 'tier') span.className = TIER_CLASS + ' ' + TIER_CLASS + '-' + r.tier;
        span.textContent = r.text;
        line.appendChild(span);
      }
      el.appendChild(line);
    } else {
      for (const r of rows) {
        const div = document.createElement('div');
        if (r.role === 'error') div.className = ERROR_CLASS;
        else if (r.role === 'sub') div.className = SUB_CLASS;
        else div.className = ROW_CLASS;
        div.textContent = r.text;
        el.appendChild(div);
      }
    }
  }
  el.classList.add('is-on');
  return (el.textContent ?? '').slice(0, 60);
}

/** 一行普通文本 */
function row(text: string): HTMLElement {
  const line = document.createElement('div');
  line.className = ROW_CLASS;
  line.textContent = text;
  return line;
}
