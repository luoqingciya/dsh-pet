// 主动陪伴的少量跨重启状态（上次主动时刻 / 今日次数 / 离开起点）。
//
// 为什么必须落盘：这几个值正是"防打扰"的抓手。只放内存的话，用户重启一次应用就重置，
// 一天里反复开关几次就能把"每日 8 次"变成 8×N 次——而这恰恰是这类功能最容易翻车的地方。
//
// 与 memory.json 同一目录（`<数据根>/dsh-pet-ng/`），但**独立文件**：它是调度状态，
// 不是用户内容，坏了直接丢弃即可（read 容错到 emptyCompanionMemory）。

import { readFileSync, writeFileSync } from 'node:fs';

import { emptyCompanionMemory } from './companion';
import type { CompanionMemory } from './companion';

/** 读：文件不存在 / 损坏 / 字段非法 → 空记忆（不抛错，调度不该因为一个计数文件崩掉） */
export function readCompanionMemory(file: string): CompanionMemory {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCompanionMemory();
    const o = raw as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
      lastActAt: num(o.lastActAt),
      dayKey: typeof o.dayKey === 'string' ? o.dayKey : '',
      dayCount: num(o.dayCount),
      awaySince: num(o.awaySince),
      snoozeUntil: num(o.snoozeUntil),
    };
  } catch {
    return emptyCompanionMemory();
  }
}

/** 写：失败静默（下次一拍会再写一次；丢了也只是多主动一两次） */
export function writeCompanionMemory(file: string, memory: CompanionMemory): void {
  try {
    writeFileSync(file, JSON.stringify(memory, null, 2) + '\n', 'utf8');
  } catch {
    /* 磁盘满/只读：不影响本次运行 */
  }
}
