/**
 * 本地应用设置页的渲染入口（浏览器 IIFE bundle：`lib/app-settings.js`）。
 *
 * 页面里没有第二条业务实现：
 *   - 「桌宠」页签 = 插件原生的 `makePetConfigSection`（`src/client/settings.ts`），一行没改；
 *   - 「本地服务」页签 = `./local-panel`，补的是 DSH 里由宿主提供、脱离后必须自带的那部分。
 *
 * 为什么这里要自己填 `petBridge`：那个对象在 DSH 里由**宠物容器**（`src/client/pet.ts`）写入
 * （当前宠物列表 / 重载回调 / 新增模板）。本地应用没有浏览器内浮层，容器不存在，所以由本页
 * 拉一次 `/config` 成品聚合并拍平后填进去——设置页拿到的数据与 DSH 内完全一致。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';

import { makePetConfigSection, petBridge, zh } from '../../client/settings';
import { flattenConfigPets } from '../../shared/config';
import type { Pet } from '../../shared/types';
import { LocalPanel } from './local-panel';

/** 页面文案：直接用插件的中文字典（键缺失回落键名，绝不显示空白） */
const t = (key: string): string => (zh as Record<string, string>)[key] ?? key;

/** 工厂要求的最小 useRef 签名（React 的 useRef 有多个重载，这里收敛成它要的那一个） */
const useRefCompat = useRef as unknown as <T>(initial: T) => MutableRefObject<T>;

/** 成品聚合 → petBridge（与 pet.ts 的写法同源） */
function adoptConfig(merged: Record<string, Record<string, unknown>>): void {
  petBridge.current = flattenConfigPets(merged);
  const main = merged.main;
  petBridge.template = Array.isArray(main?.pets) ? ((main.pets as Pet[])[0] ?? undefined) : undefined;
}

function App(): ReactElement {
  const [tab, setTab] = useState<'pet' | 'local'>('pet');
  const [version, setVersion] = useState('');
  const [error, setError] = useState('');

  // 设置页组件只造一次（内部会注入一次样式）
  const PetSection = useMemo(
    () => makePetConfigSection({ h: jsx, useState, useEffect, useRef: useRefCompat, useCallback, t }),
    [],
  );

  useEffect(() => {
    // 重载回调：设置页保存/同步后会带着成品聚合调它。本地应用里没有浏览器内浮层需要重渲染，
    // 但要把最新列表留在 petBridge 上，供下次进入页面时初始化。
    petBridge.reload = (merged?: Record<string, Record<string, unknown>>): void => {
      if (merged) adoptConfig(merged);
    };
    void (async () => {
      try {
        const merged = (await fetch('/dsh-pet-7340/config', { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })) as Record<string, Record<string, unknown>>;
        adoptConfig(merged);
      } catch (e) {
        setError(`读取桌宠配置失败：${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        const info = (await fetch('/app/api/config').then((r) => r.json())) as { runtime?: { version?: string } };
        setVersion(info.runtime?.version ?? '');
      } catch {
        /* 版本号只是展示，读不到不影响使用 */
      }
    })();
  }, []);

  return (
    <div className="shell">
      <div className="top">
        <h1>dsh-pet</h1>
        {version ? <span className="ver">v{version}</span> : null}
      </div>
      <div className="tabs" role="tablist">
        <button type="button" className="tab" role="tab" aria-selected={tab === 'pet'} onClick={() => setTab('pet')}>
          桌宠
        </button>
        <button
          type="button"
          className="tab"
          role="tab"
          aria-selected={tab === 'local'}
          onClick={() => setTab('local')}
        >
          本地服务
        </button>
      </div>
      {error ? <div className="card warn">{error}</div> : null}
      {tab === 'pet' ? <PetSection /> : <LocalPanel />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
