// 主动陪伴的**决策层**：纯函数，不读时钟、不读文件、不碰 electron、不认识任何动画名。
//
// 为什么单独一层：这块的失败方式几乎都是"太吵"，而"太吵"没法靠单元测试以外的方式调。
// 把"要不要动"抽成 `step(信号, 记忆, 配置) → {决策, 新记忆}`，就能：
//   - 用矩阵单测钉住每种情况下**必须闭嘴**（见 companion.test.ts）；
//   - 让"为什么没动"变成可观测的 reason，而不是调参时的玄学。
//
// 分层约定（与 planMove / planBubble / canStartDrive 一致）：
//   本模块只决定 **动不动、为什么**；具体播哪段动画由调用方从**这只宠物自己的**动画池里挑
//   （动作名属于素材，不属于决策）。这样宠物种类换了、池子改了，这里一行都不用动。
//
// P0 范围：只做**动作级**陪伴（走过来 / 在场时闲晃），一句话都不说。
// 说话（模板 / LLM）留给 P1/P2——那时给 Decision 加 `say` 分支，规则表在同一个 switch 里扩展。

/** 主动陪伴配置（全局一份；落在配置文件的 main 条目里） */
export interface CompanionConfig {
  /** 总开关。**默认关闭**：主动行为是"未经请求的打扰"，新版本不该替用户默认打开 */
  enabled: boolean;
  /**
   * 免打扰时段（本地小时，`[start, end)`）。
   * `null` = 不限；跨零点用 `start > end` 表达（如 23 → 8 表示 23:00–08:00）。
   */
  quietHours: { start: number; end: number } | null;
  /** 两次主动之间的最小间隔（分钟） */
  minIntervalMin: number;
  /** 每日上限（次） */
  dailyCap: number;
  /** 系统空闲多少分钟算"人离开了"（离开期间不做动作：没人看见，还白花次数）。
   *  "回来"不需要单独的阈值：离开状态解除的那一刻就是回来，见 step() 的规则 6。 */
  awayAfterMin: number;
}

/** 内置默认：保守。用户觉得太安静可以自己调小间隔、调高上限。 */
export const DEFAULT_COMPANION_CONFIG: CompanionConfig = {
  enabled: false,
  quietHours: { start: 23, end: 8 },
  minIntervalMin: 20,
  dailyCap: 8,
  awayAfterMin: 10,
};

/** 调用方每拍采集到的**事实**（全部由宿主提供，本模块不自己取） */
export interface CompanionSignals {
  /** 当前时刻（毫秒） */
  now: number;
  /** 本地小时，0–23，可带小数（8.5 = 08:30） */
  hour: number;
  /** 本地日期键（`YYYY-MM-DD`）：跨天重置计数用。由调用方按**本地时区**算，本模块不碰时区 */
  dayKey: string;
  /** 系统空闲秒数（距最后一次键鼠输入多久） */
  idleSec: number;
}

/** 跨重启保留的少量状态（落盘，见调用方） */
export interface CompanionMemory {
  /** 上次主动的时刻（0 = 从未） */
  lastActAt: number;
  /** 计数所属的日期键 */
  dayKey: string;
  /** 当天已主动次数 */
  dayCount: number;
  /** 用户"离开"的起始时刻（0 = 人在场）；回来时用它算离开了多久 */
  awaySince: number;
  /** 静音到什么时候（毫秒；0 = 没静音）。由「安静一小时」设置，落盘——重启不该解除静音 */
  snoozeUntil: number;
}

/** 什么都没发生过 */
export const emptyCompanionMemory = (): CompanionMemory => ({
  lastActAt: 0,
  dayKey: '',
  dayCount: 0,
  awaySince: 0,
  snoozeUntil: 0,
});

/**
 * 动作的**意图**（不是具体动画名）：
 *   - `greet`  人刚回来：走过去迎一下
 *   - `stroll` 人在场且待了一会儿：在身边晃一晃、伸个懒腰
 */
export type CompanionFlavor = 'greet' | 'stroll';

/** 为什么没动——排障与调参全靠它 */
export type CompanionReason = 'disabled' | 'snoozed' | 'quiet-hours' | 'away' | 'too-soon' | 'daily-cap';

export type CompanionDecision = { act: 'none'; reason: CompanionReason } | { act: 'move'; flavor: CompanionFlavor };

/** 一拍的结果：决策 + 该落盘的新记忆 */
export interface CompanionStep {
  decision: CompanionDecision;
  memory: CompanionMemory;
}

/** 小时是否落在免打扰时段内（支持跨零点） */
export function inQuietHours(hour: number, quiet: CompanionConfig['quietHours']): boolean {
  if (!quiet) return false;
  const { start, end } = quiet;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false; // 起止相同 = 不限
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // 跨零点：23–8
}

/**
 * 跑一拍。
 *
 * 规则顺序即优先级（**先判"不许动"的，再判"可以动"的**）：
 *   1. 关掉了 → disabled
 *   2. 免打扰时段 → quiet-hours
 *   3. 人不在（空闲 ≥ awayAfterMin）→ away，并记下离开时刻
 *   4. 今日次数用完 → daily-cap
 *   5. 距上次太近 → too-soon
 *   6. 人刚回来（空闲 ≤ backIdleSec 且之前记过离开）→ move(greet)
 *   7. 其余情况（人在场）→ move(stroll)
 *
 * 注意第 3 条与第 6 条是一对：`awaySince` 在"离开"时置位、在"回来"时消费一次。
 * 这样"刚回来"只触发一次，不会因为连续几拍都空闲很低而反复迎接。
 */
export function step(signals: CompanionSignals, memory: CompanionMemory, cfg: CompanionConfig): CompanionStep {
  const { now, hour, dayKey, idleSec } = signals;

  // 跨天重置（计数与"离开"状态都归零：昨天的次数不该压今天的额度）
  const rolled: CompanionMemory = memory.dayKey === dayKey ? memory : { ...memory, dayKey, dayCount: 0, awaySince: 0 };

  if (!cfg.enabled) return { decision: { act: 'none', reason: 'disabled' }, memory: rolled };

  // 用户手动静音（右键「安静一小时」）：优先于一切规则——那是用户的明确意愿
  if (rolled.snoozeUntil > now) {
    return { decision: { act: 'none', reason: 'snoozed' }, memory: rolled };
  }
  // 静音已过期：顺手清掉（别让落盘文件里一直留着一个过去的时间戳）
  const cur: CompanionMemory = rolled.snoozeUntil > 0 ? { ...rolled, snoozeUntil: 0 } : rolled;

  if (inQuietHours(hour, cfg.quietHours)) {
    return { decision: { act: 'none', reason: 'quiet-hours' }, memory: cur };
  }

  // 人离开了：记下起点，别做动作（没人看见，还白花次数）
  if (idleSec >= cfg.awayAfterMin * 60) {
    const awaySince = cur.awaySince || now;
    return { decision: { act: 'none', reason: 'away' }, memory: { ...cur, awaySince } };
  }

  if (cur.dayCount >= cfg.dailyCap) {
    return { decision: { act: 'none', reason: 'daily-cap' }, memory: cur };
  }
  if (cur.lastActAt > 0 && now - cur.lastActAt < cfg.minIntervalMin * 60_000) {
    return { decision: { act: 'none', reason: 'too-soon' }, memory: cur };
  }

  // 人刚回来（离开状态刚解除）：迎接一次，并消费 awaySince——避免连续几拍反复迎接
  if (cur.awaySince > 0) {
    return {
      decision: { act: 'move', flavor: 'greet' },
      memory: { ...cur, lastActAt: now, dayCount: cur.dayCount + 1, awaySince: 0 },
    };
  }

  // 人在场：闲晃一下
  return {
    decision: { act: 'move', flavor: 'stroll' },
    memory: { ...cur, lastActAt: now, dayCount: cur.dayCount + 1 },
  };
}

/**
 * 把配置里的一段 `companion` 规范化成可用值；非法返回 `null`。
 *
 * 两个用途，同一份规则：
 *   - `core/config.ts` 的白名单校验（`null` 即配置写错，告警并回退默认）；
 *   - 消费端读取（`?? DEFAULT_COMPANION_CONFIG`）。
 *
 * 宽容与严格的分界：**字段缺失取默认**（老配置没有这一段是正常的），
 * **字段写了但写错就判整段非法**（与仓库里其它段的处理一致：静默兜底比报错更难查）。
 */
export function normalizeCompanionConfig(raw: unknown): CompanionConfig | null {
  if (raw === undefined || raw === null) return DEFAULT_COMPANION_CONFIG;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, min: number): number | null => {
    if (v === undefined) return null; // 缺失 → 调用方取默认
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : Number.NaN;
  };

  const out: CompanionConfig = { ...DEFAULT_COMPANION_CONFIG };

  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') return null;
    out.enabled = o.enabled;
  }

  if (o.quietHours !== undefined) {
    if (o.quietHours === null) out.quietHours = null;
    else {
      const q = o.quietHours;
      if (typeof q !== 'object' || Array.isArray(q)) return null;
      const { start, end } = q as { start?: unknown; end?: unknown };
      const s = Number(start);
      const e = Number(end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || s > 24 || e < 0 || e > 24) return null;
      out.quietHours = { start: s, end: e };
    }
  }

  const minInterval = num(o.minIntervalMin, 1);
  if (Number.isNaN(minInterval)) return null;
  if (minInterval !== null) out.minIntervalMin = minInterval;

  const cap = num(o.dailyCap, 0);
  if (Number.isNaN(cap)) return null;
  if (cap !== null) out.dailyCap = Math.floor(cap);

  const away = num(o.awayAfterMin, 1);
  if (Number.isNaN(away)) return null;
  if (away !== null) out.awayAfterMin = away;

  return out;
}
