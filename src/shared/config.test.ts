/**
 * 成品 → 渲染列表的契约测试：条目级字段只有**一处**填充点（flattenConfigPets）。
 *
 * 背景：animations / animationWeights / eventsRefreshSec / physics / confineToScreen / workStatusTexts /
 * whisperModel / chatModel 这八个条目级字段必须由 flattenConfigPets 从「条目」吹进每只实例。
 * 桌面渲染端（src/desktop 的 sprite.js）读的就是拍平后的列表：漏掉 physics，
 * 拖拽跟手第一帧读 cfg.physics.throwPower 会直接抛错（表现为宠物完全拖不动）。
 *
 * 本文件钉住两件事：
 *   ① 可执行契约：成品经 flattenConfigPets 后每只实例的条目级字段齐全（用真实内置默认配置）；
 *   ② 源码守卫：host 的写接口返回成品聚合，且设置页的「保存」把可编辑字段**全部**提交
 *      （设置页是 TSX，无法在 node 里渲染，只能读源码断言）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { flattenConfigPets } from './config.ts';
import { readAllConfig } from '../core/config.ts';
import type { Pet } from './types.ts';

/** 条目级字段清单：桌面渲染直接消费，缺一不可 */
const ENTRY_FIELDS: Array<keyof Pet> = [
  'animations',
  'animationWeights',
  'eventsRefreshSec',
  'physics',
  'confineToScreen',
  'workStatusTexts',
  'whisperModel',
  'chatModel',
];

/** 包内文件源码（守卫用；相对 src/shared/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('flattenConfigPets —— 成品 → 渲染列表的唯一填充点', () => {
  test('真实内置默认配置：每只实例的条目级字段齐全（含 physics.throwPower）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-ng-flatten-'));
    try {
      const merged = readAllConfig({
        defaultFile: fileURLToPath(new URL('../../assets/config.jsonc', import.meta.url)),
        userFile: join(dir, 'main-config.jsonc'), // 不存在：只测内置默认
        petDir: join(dir, 'pet'), // 不存在：不掺文件宠物
      });
      const pets = flattenConfigPets(merged);
      assert.ok(pets.length > 0, '内置默认配置应至少有一只宠物');
      for (const p of pets) {
        for (const field of ENTRY_FIELDS) {
          assert.ok(p[field] !== undefined, `宠物「${String(p.id)}」缺条目级字段 ${field}`);
        }
        // 拖拽跟手第一帧读的就是它；缺失即 TypeError
        const physics = p.physics as { throwPower?: unknown };
        assert.equal(typeof physics.throwPower, 'number', 'physics.throwPower 必须是数字');
        // animations 是 { idle/turn/drag/clicks/moves/categories/events } 段：待机池必须非空
        const animations = p.animations as { idle?: unknown };
        assert.ok(Array.isArray(animations.idle) && animations.idle.length > 0, 'animations.idle 应为非空待机动画池');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('条目级字段的来源是「条目」而非实例：实例写同名值也不生效（唯一来源 = conf）', () => {
    const merged = {
      main: {
        physics: { throwPower: 7 },
        animations: ['a.webm'],
        pets: [{ id: 'x', physics: { throwPower: 1 } }],
      },
    };
    const [pet] = flattenConfigPets(merged as Record<string, Record<string, unknown>>);
    assert.deepEqual(pet.physics, { throwPower: 7 });
    assert.deepEqual(pet.animations, ['a.webm']);
  });

  test('源码守卫：host 写接口返回成品聚合，设置页的提交面必须完整', () => {
    const panel = readSource('../ui/pet-panel.tsx');
    const host = readSource('../api/host.ts') + readSource('../api/router.ts');

    // ① 四个写/读接口都返回成品聚合——设置页拿响应直接刷新，不自己拼字段
    const returns = host.match(/obj: readAllConfig\(configPaths\)/g) ?? [];
    assert.equal(returns.length, 4, 'GET / PUT / POST /config 与 POST /pet-display 都应返回成品聚合');
    const configBlock = /if \(rest === 'config'\) \{([\s\S]*?)\n {4}\}/.exec(host)?.[1] ?? '';
    assert.ok(configBlock.length > 0, '必须能定位到 /config 路由段（守卫失效即无意义）');
    assert.ok(
      !/obj: \{ ok: true \}/.test(configBlock),
      'config 写接口不得返回 { ok: true }：响应体必须是成品聚合（设置页即时生效靠它刷新）',
    );

    // ② 保存的「透传保留」必须用 JSONC 容忍解析器读用户层（带注释的配置用严格 JSON.parse 会失败，
    //    保存时静默丢掉全部高级字段）
    assert.ok(/readUserConfig\(configPaths\)/.test(host), 'PUT /config 必须用 readUserConfig 读用户层（JSONC 容忍）');

    // ③ 保存前必须有损坏预检：用户层解析不了时先不写盘，回 409 让设置页弹窗
    assert.ok(
      /userConfigUnparsable\(configPaths\)/.test(host),
      'PUT /config 必须先做损坏预检（userConfigUnparsable），损坏时回 409 而不是静默重建',
    );

    // ④ 设置页的「保存」必须真的把可编辑字段提交上去：漏一个，界面上改了也写不进用户层
    const saveBody = /const body: SaveBody = \{([\s\S]*?)\n {6}\};/.exec(panel);
    assert.ok(saveBody, '设置页必须有「保存」的请求体字面量（const body: SaveBody）');
    for (const field of [
      'pets',
      'physics',
      'font',
      'whisperImageEnabled',
      'chatImageEnabled',
      'confineToScreen',
      'chatMemoryRounds',
      'chatImageLimit',
    ]) {
      assert.ok(
        new RegExp(`(^|[^\\w.])${field}\\b`, 'm').test(saveBody[1]),
        `「保存」的请求体必须带上 ${field}（否则设置页改的值不会落盘）`,
      );
    }

    // ⑤ 模型统一由「本地服务」决定：面板必须显式写空，避免从 DSH 迁移来的旧 provider 继续生效
    assert.ok(
      /whisperModel: \{ provider: '', model: '' \}/.test(panel) &&
        /chatModel: \{ provider: '', model: '' \}/.test(panel),
      '桌宠面板必须显式清空 whisperModel / chatModel（模型统一在本地服务页签配置）',
    );

    // ⑥ 保存按钮不得把带默认参数的 save 直接交给 React（MouseEvent 会被当成 force）
    assert.ok(
      !/onClick: save\b/.test(panel),
      '保存按钮必须写 onClick: () => void save()：直接把 save 交给 React 会把 MouseEvent 当 force',
    );
    assert.ok(
      /force === true \? '\?force=1'/.test(panel),
      'force 必须严格比较 true（真值判断会让任何实参都开启强行覆盖）',
    );

    // ⑦ 显示位置只有桌面/隐藏两种：本应用没有浏览器浮层，面板不得再写 web / both
    assert.ok(!/'(web|both)'/.test(panel), '桌宠面板不得再提供 web / both 两种显示位置（本应用只有桌面透明窗）');

    // ⑧ 模型清单的数据源仍是宿主 llm 服务（本地实现也走同一入口）
    assert.ok(
      /listProviders/.test(host) && /listModels/.test(host),
      'GET /models 必须取宿主 llm 服务的 listProviders / listModels',
    );
  });
});
