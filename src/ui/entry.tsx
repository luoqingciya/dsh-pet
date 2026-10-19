/**
 * 设置页渲染入口（浏览器 IIFE bundle：`lib/app-settings.js`）。
 *
 * 两个页签：
 *   - 桌宠：`./pet-panel` —— 大小 / 位置 / 功能开关 / 外观 / 手感 / 存储；
 *   - 本地服务：`./local-panel` —— 模型端点、API Key、余额服务商、通知开关。
 *
 * 为什么设置页走 HTTP 而不是 Electron IPC：页面与宿主同源，`/dsh-pet-ng-7340/*` 与 `/app/api/*`
 * 直接可用；顺带让排障时能用普通浏览器打开同一页（`http://127.0.0.1:7340/app/`）。
 */
import { useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { LocalPanel } from './local-panel';
import { PetPanel } from './pet-panel';

/** 版本号只是页头展示，读不到不影响使用 */
async function readVersion(): Promise<string> {
  try {
    const info = (await fetch('/app/api/config').then((res) => res.json())) as { runtime?: { version?: string } };
    return info.runtime?.version ?? '';
  } catch {
    return '';
  }
}

function App(): ReactElement {
  const [tab, setTab] = useState<'pet' | 'local'>('pet');
  const [version, setVersion] = useState('');

  useEffect(() => {
    void readVersion().then(setVersion);
  }, []);

  return (
    <div className="shell">
      <div className="top">
        <h1>dsh-petNG</h1>
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
      {tab === 'pet' ? <PetPanel /> : <LocalPanel />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
