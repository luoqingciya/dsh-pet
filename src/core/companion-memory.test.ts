/**
 * 主动陪伴的持久化测试（core/companion-memory.ts）。
 *
 * 只钉两件事：**能读回来**、**坏文件不炸**。后者是重点——这个文件存的是"今天已经打扰了几次"，
 * 它损坏时唯一正确的行为是当作"没打扰过"继续跑，而不是让调度器抛错停摆
 * （否则用户删改一下这个文件，主动陪伴就永久失效了）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readCompanionMemory, writeCompanionMemory } from './companion-memory.ts';
import { emptyCompanionMemory } from './companion.ts';

function withTempFile(fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'companion-mem-'));
  try {
    fn(join(dir, 'companion.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('companion-memory —— 读写往返', () => {
  test('写进去再读出来，字段一模一样', () => {
    withTempFile((file) => {
      const mem = { lastActAt: 1234, dayKey: '2026-10-20', dayCount: 3, awaySince: 999 };
      writeCompanionMemory(file, mem);
      assert.deepEqual(readCompanionMemory(file), mem);
    });
  });

  test('文件不存在 → 空记忆（首次运行）', () => {
    withTempFile((file) => {
      assert.deepEqual(readCompanionMemory(file), emptyCompanionMemory());
    });
  });

  test('文件损坏 → 空记忆，不抛错', () => {
    withTempFile((file) => {
      writeFileSync(file, '{ 这不是 JSON', 'utf8');
      assert.deepEqual(readCompanionMemory(file), emptyCompanionMemory());
    });
  });

  test('字段类型不对 → 逐字段兜底为 0，不整体丢弃', () => {
    withTempFile((file) => {
      writeFileSync(file, JSON.stringify({ lastActAt: 'x', dayKey: 42, dayCount: -1 }), 'utf8');
      assert.deepEqual(readCompanionMemory(file), emptyCompanionMemory());
    });
  });

  test('写不进去（父目录不存在）→ 静默，不抛错', () => {
    assert.doesNotThrow(() => {
      writeCompanionMemory(join(tmpdir(), 'no-such-dir-' + Date.now(), 'x.json'), emptyCompanionMemory());
    });
  });
});
