/**
 * 气泡单槽的测试（shared/bubble.ts）。
 *
 * 分两块：
 *   ① `planBubble` —— **纯决策**，穷举"谁压过谁"。这块的坑全在优先级上（终态任务不让位、
 *      对话回复又要压过终态），从前只能靠"浏览器与桌面两份实现都别改错"维持。
 *   ② `renderBubbleInto` —— DOM 渲染，用最小 DOM 桩断言**类名与行结构**。
 *      类名不是随便起的：样式全在 shared 的 CSS 里（pet-bub-row / -sub / -err / -tier-<档位>），
 *      改错一个字符就是"气泡没样式"，而这种问题在真机上只会表现为"看着怪"，很难归因。
 *
 * 全部用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { planBubble, renderBubbleInto } from './bubble.ts';
import type { BubbleContent, BubbleFlags, BubblePlan } from './bubble.ts';
import type { BalanceBubbleRow } from './balance.ts';

/** 全部为假：空槽 */
const idle: BubbleFlags = {
  work: false,
  workTerminal: false,
  whisper: false,
  whisperReply: false,
  balance: false,
  balanceCompact: false,
};

describe('planBubble —— 单槽优先级', () => {
  test('全空 → none', () => {
    assert.deepEqual(planBubble(idle), { slot: 'none', compact: false });
  });

  test('只有说话 → whisper（紧凑变体）', () => {
    assert.deepEqual(planBubble({ ...idle, whisper: true }), { slot: 'whisper', compact: true });
  });

  test('只有余额 → balance（普通变体）', () => {
    assert.deepEqual(planBubble({ ...idle, balance: true }), { slot: 'balance', compact: false });
  });

  test('余额「不可用」文字说明 → balance + 紧凑变体（多行要窄一些）', () => {
    assert.deepEqual(planBubble({ ...idle, balance: true, balanceCompact: true }), {
      slot: 'balance',
      compact: true,
    });
  });

  test('只有工作 → work', () => {
    assert.deepEqual(planBubble({ ...idle, work: true }), { slot: 'work', compact: true });
  });

  test('说话压过余额', () => {
    assert.equal(planBubble({ ...idle, whisper: true, balance: true }).slot, 'whisper');
  });

  test('终态任务压过说话与余额（完成/失败只活 10s，被顶掉就再也看不到）', () => {
    const f = { ...idle, work: true, workTerminal: true, whisper: true, balance: true };
    assert.equal(planBubble(f).slot, 'work');
  });

  test('对话回复压过终态任务（那是用户刚问出来的答案，"这轮搞定啦"只是装饰）', () => {
    const f = { ...idle, work: true, workTerminal: true, whisper: true, whisperReply: true };
    assert.equal(planBubble(f).slot, 'whisper');
  });

  test('非终态任务让位于说话与余额（它常驻，让 10s 零损失）', () => {
    assert.equal(planBubble({ ...idle, work: true, whisper: true }).slot, 'whisper');
    assert.equal(planBubble({ ...idle, work: true, balance: true }).slot, 'balance');
  });

  test('非终态任务自己也能显示（没有任何更高优先级时）', () => {
    assert.equal(planBubble({ ...idle, work: true, workTerminal: false }).slot, 'work');
  });

  test('compact 只跟最终槽位有关：说话/工作恒紧凑，余额看是否文字说明', () => {
    assert.equal(planBubble({ ...idle, whisper: true }).compact, true);
    assert.equal(planBubble({ ...idle, work: true }).compact, true);
    assert.equal(planBubble({ ...idle, balance: true }).compact, false);
    assert.equal(planBubble({ ...idle, balance: true, balanceCompact: true }).compact, true);
    assert.equal(planBubble(idle).compact, false);
  });
});

// ---------- DOM 桩 ----------

/**
 * 把桩元素当 HTMLElement 交给被测函数。
 *
 * 这是**测试边界上的断言**：桩故意只实现用到的那几个成员，不可能结构上等于 HTMLElement。
 * 运行时它就是桩——被测函数只调 createElement/appendChild/classList/textContent/innerHTML。
 */
const asHTMLElement = (el: unknown): HTMLElement => el as HTMLElement;

/**
 * 最小 DOM 桩：只实现 renderBubbleInto 用到的那些（createElement / className / textContent /
 * appendChild / innerHTML / classList）。够用即可，不引 jsdom。
 */
function fakeDom() {
  interface FakeEl {
    tag: string;
    className: string;
    children: FakeEl[];
    textContent: string;
    innerHTML: string;
    appendChild(c: FakeEl): FakeEl;
    classList: {
      add(...c: string[]): void;
      remove(...c: string[]): void;
      toggle(c: string, force?: boolean): boolean;
      has(c: string): boolean;
    };
    readonly classes: Set<string>;
  }

  const make = (tag: string): FakeEl => {
    const classes = new Set<string>();
    const el: FakeEl = {
      tag,
      children: [],
      get className() {
        return [...classes].join(' ');
      },
      set className(v: string) {
        classes.clear();
        for (const c of String(v).split(/\s+/)) if (c) classes.add(c);
      },
      get classes() {
        return classes;
      },
      /** 与 DOM 一致：读取聚合全部后代文本；赋值则替换全部子节点 */
      get textContent(): string {
        return (own.get(el) ?? '') + el.children.map((c) => c.textContent).join('');
      },
      set textContent(v: string) {
        own.set(el, String(v));
        el.children.length = 0;
      },
      get innerHTML() {
        return '';
      },
      set innerHTML(_v: string) {
        own.set(el, '');
        el.children.length = 0;
      },
      appendChild(c: FakeEl) {
        el.children.push(c);
        return c;
      },
      classList: {
        add: (...c: string[]) => c.forEach((x) => classes.add(x)),
        remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
        toggle: (c: string, force?: boolean) => {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c);
          else classes.delete(c);
          return on;
        },
        has: (c: string) => classes.has(c),
      },
    };
    own.set(el, '');
    return el;
  };

  /** 每个元素自己的文本（子节点文本单独算） */
  const own = new WeakMap<FakeEl, string>();

  /** 断言用：与 DOM 的 textContent 同一语义（含全部后代） */
  const textOf = (el: FakeEl): string => el.textContent;

  const g = globalThis as { document?: unknown };
  const prev = g.document;
  g.document = {
    createElement: (tag: string) => make(tag),
    // 桩里没有样式表：createMemeImage 之类若走到注入分支，直接当"已注入"处理
    querySelector: () => null,
    head: { appendChild: () => {} },
  };
  return {
    make,
    /** 真实的 textContent（含子节点），断言用 */
    text: textOf,
    restore: () => {
      g.document = prev;
    },
  };
}

let restoreDom: (() => void) | null = null;
afterEach(() => {
  restoreDom?.();
  restoreDom = null;
});

/** 装好 DOM 桩并返回一个气泡根元素（用例结束自动还原） */
function bubbleWithDom() {
  const dom = fakeDom();
  restoreDom = dom.restore;
  return { dom, el: dom.make('div') };
}

/** 跑一次渲染（把桩元素按 HTMLElement 传进去） */
function render(el: unknown, plan: BubblePlan, content: BubbleContent): string {
  return renderBubbleInto(asHTMLElement(el), plan, content);
}

const emptyContent: BubbleContent = { workText: null, whisperText: '', meme: null, balanceRows: null };

describe('renderBubbleInto —— 空槽与可见性', () => {
  test('none：隐藏（移除 is-on）、不产生子节点、标题为空', () => {
    const { dom, el } = bubbleWithDom();
    el.classList.add('is-on');
    const title = render(el, planBubble(idle), emptyContent);
    assert.equal(title, '');
    assert.equal(el.classList.has('is-on'), false);
    assert.equal(el.children.length, 0);
    assert.equal(dom.text(el), '');
  });

  test('有内容：加 is-on，标题取前 60 字符', () => {
    const { el } = bubbleWithDom();
    const long = 'x'.repeat(100);
    const title = render(el, planBubble({ ...idle, work: true }), {
      ...emptyContent,
      workText: long,
    });
    assert.equal(el.classList.has('is-on'), true);
    assert.equal(title.length, 60);
  });
});

describe('renderBubbleInto —— 各槽位的行结构', () => {
  test('work：一行 pet-bub-row + is-whisper（长文案要能折行）', () => {
    const { el } = bubbleWithDom();
    render(el, planBubble({ ...idle, work: true }), { ...emptyContent, workText: '跑测试' });
    assert.equal(el.children.length, 1);
    assert.equal(el.children[0].className, 'pet-bub-row');
    assert.equal(el.classList.has('is-whisper'), true);
  });

  test('whisper：配图在前、文字在后（先看图再读话）', () => {
    const { dom, el } = bubbleWithDom();
    const meme = dom.make('img');
    render(el, planBubble({ ...idle, whisper: true }), {
      ...emptyContent,
      whisperText: '今天也在努力',
      meme: asHTMLElement(meme),
    });
    assert.equal(el.children.length, 2);
    assert.equal(el.children[0], meme, '配图必须是第一个子节点');
    assert.equal(el.children[1].className, 'pet-bub-row');
    assert.equal(dom.text(el), '今天也在努力');
  });

  test('whisper 无配图：只有一行，且不加配图变体类（has-img 会取消 min-width）', () => {
    const { el } = bubbleWithDom();
    render(el, planBubble({ ...idle, whisper: true }), { ...emptyContent, whisperText: '嗯' });
    assert.equal(el.children.length, 1);
    assert.equal(el.classList.has('has-img'), false);
  });

  test('whisper 带配图：加 has-img（带图时宽度随图走）', () => {
    const { dom, el } = bubbleWithDom();
    render(el, planBubble({ ...idle, whisper: true }), {
      ...emptyContent,
      whisperText: '嗯',
      meme: asHTMLElement(dom.make('img')),
    });
    assert.equal(el.classList.has('has-img'), true);
  });

  test('balance 带档位：单行多 span，档位字带 pet-bub-tier-<档位>', () => {
    const { dom, el } = bubbleWithDom();
    const rows: BalanceBubbleRow[] = [
      { role: 'label', text: '余额' },
      { role: 'tier', tier: 'peak', text: '¥12.34' },
    ];
    render(el, planBubble({ ...idle, balance: true }), { ...emptyContent, balanceRows: rows });
    assert.equal(el.children.length, 1, '带档位时拼成一行');
    const line = el.children[0];
    assert.equal(line.className, 'pet-bub-row');
    assert.equal(line.children.length, 2);
    assert.equal(line.children[1].className, 'pet-bub-tier pet-bub-tier-peak');
    assert.equal(dom.text(el), '余额¥12.34');
  });

  test('balance 不带档位：每行一个 div，error/sub/普通各有自己的类', () => {
    const { dom, el } = bubbleWithDom();
    const rows: BalanceBubbleRow[] = [
      { role: 'error', text: '查询失败' },
      { role: 'sub', text: '缺 API Key' },
      { role: 'label', text: '余额' },
    ];
    render(el, planBubble({ ...idle, balance: true, balanceCompact: true }), {
      ...emptyContent,
      balanceRows: rows,
    });
    assert.deepEqual(
      el.children.map((c) => c.className),
      ['pet-bub-err', 'pet-bub-row pet-bub-sub', 'pet-bub-row'],
    );
    assert.equal(dom.text(el), '查询失败缺 API Key余额');
  });

  test('余额行意外为空：不显示（而不是留个空气泡挡住下层）', () => {
    const { el } = bubbleWithDom();
    const title = render(el, planBubble({ ...idle, balance: true }), {
      ...emptyContent,
      balanceRows: [],
    });
    assert.equal(title, '');
    assert.equal(el.classList.has('is-on'), false);
    assert.equal(el.children.length, 0);
  });
});

describe('renderBubbleInto —— 幂等', () => {
  test('重复渲染不叠加节点（上一槽的内容必须清掉）', () => {
    const { el } = bubbleWithDom();
    render(el, planBubble({ ...idle, work: true }), { ...emptyContent, workText: '干活中' });
    render(el, planBubble({ ...idle, work: true }), { ...emptyContent, workText: '干活中' });
    assert.equal(el.children.length, 1, '重建前必须先清空');

    // 换槽：说话 → 工作，上一槽的节点不能残留
    render(el, planBubble({ ...idle, whisper: true }), { ...emptyContent, whisperText: '嗯' });
    render(el, planBubble({ ...idle, work: true }), { ...emptyContent, workText: '干活中' });
    assert.equal(el.children.length, 1);
    assert.equal(el.children[0].className, 'pet-bub-row');
  });

  test('从可见切到空槽：is-on 被摘掉', () => {
    const { el } = bubbleWithDom();
    render(el, planBubble({ ...idle, work: true }), { ...emptyContent, workText: '干活中' });
    assert.equal(el.classList.has('is-on'), true);
    render(el, planBubble(idle), emptyContent);
    assert.equal(el.classList.has('is-on'), false);
  });
});
