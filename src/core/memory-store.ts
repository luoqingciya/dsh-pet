/**
 * 对话记忆的落盘与串行化。
 *
 * 结构双层：`{ <种类桶 assetRoot ?? petId>: { <实例 id>: { messages: ChatMemoryMessage[] } } }`。
 * 唯一读写方是本进程——桌面窗口与设置页都只是客户端，所以同一实例天然共享同一份记忆。
 *
 * 三个职责收在一处：
 *   1. 读：文件不存在 → 空；**损坏 → 显式告警 + 备份原始文件 + 重建空记忆**（绝不静默丢数据）；
 *   2. 写：read-modify-write 走同一个串行队列，防并发对话交错写盘；
 *   3. 轮数：每只宠物保留几轮记忆（所属条目的 chatMemoryRounds，合并器已填默认）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { findPetInstance } from './config';
import type { ChatMemoryMessage } from './chat';

/** 记忆文件的形状 */
export type MemoryBook = Record<string, Record<string, { messages: ChatMemoryMessage[] }>>;

export interface MemoryStoreOptions {
  /** 用户数据根（`$DSH_HOME/dsh-pet-ng`）—— 记忆文件与备份都落在这里 */
  rootDir: string;
  /** 记忆文件名（默认 `memory.json`） */
  fileName?: string;
  /** 告警输出（默认 console.error） */
  warn?: (message: string) => void;
}

export interface MemoryStore {
  /** 读记忆文件（不存在 → 空；损坏 → 备份并重建） */
  read(): Promise<MemoryBook>;
  /** 整份写回 */
  write(mem: MemoryBook): Promise<void>;
  /** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** 该宠物保留几轮记忆（1 轮 = 1 问 1 答） */
  roundsFor(petId: string, cfg: Record<string, Record<string, unknown>>): number;
}

export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const rootDir = options.rootDir;
  const file = join(rootDir, options.fileName ?? 'memory.json');
  const warn = options.warn ?? ((message: string) => console.error(message));

  /** 对话写操作串行队列：read-modify-write 排队执行，防并发对话时交错写盘 */
  let queue: Promise<void> = Promise.resolve();

  return {
    async read(): Promise<MemoryBook> {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        return {}; // 文件不存在 = 尚无记忆
      }
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        return parsed as MemoryBook;
      } catch (e) {
        warn(
          `dsh-petNG: 记忆文件损坏已备份（对话将从头开始）：${file}（${e instanceof Error ? e.message : String(e)}）`,
        );
        try {
          await mkdir(rootDir, { recursive: true });
          await writeFile(`${file}.bak-${Date.now()}`, raw, 'utf8');
        } catch {
          /* 备份失败仅告警，不阻断 */
        }
        return {};
      }
    },

    async write(mem: MemoryBook): Promise<void> {
      await mkdir(rootDir, { recursive: true });
      await writeFile(file, JSON.stringify(mem, null, 2), 'utf8');
    },

    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = queue.then(fn, fn);
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    roundsFor(petId: string, cfg: Record<string, Record<string, unknown>>): number {
      const found = findPetInstance(cfg, petId);
      const v = Number(found?.conf.chatMemoryRounds ?? cfg.main?.chatMemoryRounds);
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
    },
  };
}
