/**
 * 「桌宠」设置面板 —— 本地应用版的宠物配置。
 *
 * 与它替代的旧实现（DSH 插件的 `src/client/settings.ts`）相比，**选项内容按本地应用的定位重写**：
 *   - 没有「浏览器 / 桌面 / 两者」四种显示位置了：本应用只有桌面透明窗，选项收敛为「显示在桌面」；
 *   - 没有「跟随当前对话的模型」：本地应用没有"当前对话"，模型与密钥统一在「本地服务」页签配置，
 *     这里保存时会**显式清空** whisperModel / chatModel，避免从 DSH 迁移过来的旧配置继续指向
 *     DSH 的服务商（那会表现为"明明配了 DeepSeek 却说服务商不存在"）；
 *   - 没有 Web Notification 的权限/测试按钮：通知是原生通知，开关在「本地服务」页签；
 *   - 去掉 DSH 设置页那套 `--dsw-alias-*` 主题变量，直接复用本页的卡片样式。
 *
 * 数据契约不变：`GET /dsh-pet-7340/config` 读**成品聚合**（字段已填满，零兜底），
 * `PUT /dsh-pet-7340/config` 保存（宿主白名单重建 + 重启桌面窗口），`POST` 恢复默认。
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { DEFAULT_FONT, FONT_PRESETS, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../shared/fonts';
import { DEFAULT_PHYSICS } from '../../shared/physics';
import type { Corner, FontFamilyId, PhysicsParams, Pet, PetDisplay } from '../../shared/types';

/** 可编辑的宠物条目（只保留本面板会写的字段） */
interface PetDraft {
  id: string;
  name: string;
  size: number;
  balanceEnabled: boolean;
  whisperEnabled: boolean;
  workStatusEnabled: boolean;
  fixedEnabled: boolean;
  display: PetDisplay;
  position: { corner: Corner; marginX: number; marginY: number };
}

/** 成品聚合里 main 条目用到的字段 */
interface MainConfig {
  pets: Pet[];
  physics?: PhysicsParams;
  font?: { family: FontFamilyId; size: number; followPet: boolean };
  whisperImageEnabled?: boolean;
  chatImageEnabled?: boolean;
  confineToScreen?: boolean;
  chatMemoryRounds?: number;
  chatImageLimit?: number;
}

/** 配置文件与目录（`/config/meta`） */
interface ConfigMeta {
  user?: string;
  default?: string;
  animations?: string;
}

/** 保存请求体（宿主白名单字段；未列出的顶层字段由宿主从磁盘透传保留） */
interface SaveBody {
  pets: PetDraft[];
  physics: PhysicsParams;
  font: { family: FontFamilyId; size: number; followPet: boolean };
  whisperImageEnabled: boolean;
  chatImageEnabled: boolean;
  confineToScreen: boolean;
  chatMemoryRounds: number;
  chatImageLimit: number;
  /** 恒为空：模型统一由「本地服务」决定（见文件头） */
  whisperModel: { provider: string; model: string };
  chatModel: { provider: string; model: string };
}

/** 角落选项 */
const CORNERS: Array<{ id: Corner; label: string }> = [
  { id: 'top-left', label: '左上角' },
  { id: 'top-right', label: '右上角' },
  { id: 'bottom-left', label: '左下角' },
  { id: 'bottom-right', label: '右下角' },
];

/** 字体选项的显示名（id → 中文名；清单本身来自 shared/fonts.ts） */
const FONT_LABELS: Record<FontFamilyId, string> = {
  candy: '软糖体（内置）',
  yahei: '微软雅黑 / 苹方',
  youyuan: '幼圆',
  kaiti: '楷体',
  simsun: '宋体',
  comic: '漫画体',
  system: '系统默认',
};

/** 尺寸合法区间（px）：过小看不清、过大一屏放不下 */
const SIZE_MIN = 120;
const SIZE_MAX = 800;

/** 从成品条目抽出可编辑字段 */
function draftOf(pet: Pet): PetDraft {
  return {
    id: pet.id,
    name: pet.name || pet.id,
    size: pet.size,
    balanceEnabled: pet.balanceEnabled,
    whisperEnabled: pet.whisperEnabled !== false,
    workStatusEnabled: pet.workStatusEnabled !== false,
    fixedEnabled: pet.fixedEnabled === true,
    // 只有桌面透明窗：把旧配置里的 web / both 一律收敛成 desktop（保存后即归一）
    display: pet.display === 'none' ? 'none' : 'desktop',
    position: { ...pet.position },
  };
}

/** 生成一个未占用的宠物 id */
function nextId(list: PetDraft[]): string {
  for (let n = 2; ; n += 1) {
    const id = `pet-${n}`;
    if (!list.some((pet) => pet.id === id)) return id;
  }
}

/** 统一请求（失败时把宿主给的错误文案带出来） */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    const error = (body as { error?: unknown })?.error;
    throw Object.assign(new Error(typeof error === 'string' ? error : `HTTP ${res.status}`), {
      status: res.status,
      body,
    });
  }
  return body as T;
}

export function PetPanel(): ReactElement {
  const [pets, setPets] = useState<PetDraft[]>([]);
  const [selected, setSelected] = useState('');
  const [physics, setPhysics] = useState<PhysicsParams>(DEFAULT_PHYSICS);
  const [font, setFont] = useState({ ...DEFAULT_FONT });
  const [globals, setGlobals] = useState({
    whisperImageEnabled: false,
    chatImageEnabled: false,
    confineToScreen: true,
    chatMemoryRounds: 5,
    chatImageLimit: 0,
  });
  const [meta, setMeta] = useState<ConfigMeta>({});
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: '' | 'ok' | 'err'; text: string }>({ kind: '', text: '' });
  const [dialog, setDialog] = useState<null | { kind: 'remove' | 'lastOne' | 'reset' | 'corrupt'; path?: string }>(
    null,
  );

  /** 用成品聚合刷新全部状态 */
  const adopt = useCallback((merged: Record<string, MainConfig>) => {
    const main = merged.main;
    const list = Array.isArray(main?.pets) ? main.pets : [];
    const drafts = list.map(draftOf);
    setPets(drafts);
    setSelected((prev) => (drafts.some((pet) => pet.id === prev) ? prev : (drafts[0]?.id ?? '')));
    setPhysics({ ...DEFAULT_PHYSICS, ...(main?.physics ?? {}) });
    setFont({ ...DEFAULT_FONT, ...(main?.font ?? {}) });
    setGlobals({
      whisperImageEnabled: main?.whisperImageEnabled === true,
      chatImageEnabled: main?.chatImageEnabled === true,
      confineToScreen: main?.confineToScreen !== false,
      chatMemoryRounds: Number.isFinite(main?.chatMemoryRounds) ? Number(main?.chatMemoryRounds) : 5,
      chatImageLimit: Number.isFinite(main?.chatImageLimit) ? Number(main?.chatImageLimit) : 0,
    });
    setLoadState('ready');
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoadState('loading');
    try {
      const merged = await request<Record<string, MainConfig>>('/dsh-pet-7340/config', { cache: 'no-store' });
      adopt(merged);
      // 路径信息只是展示，读不到不影响编辑
      const info = await request<ConfigMeta>('/dsh-pet-7340/config/meta').catch(() => ({}));
      setMeta(info);
    } catch (error) {
      setLoadState('error');
      setMsg({ kind: 'err', text: `读取配置失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }, [adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(() => pets.find((pet) => pet.id === selected), [pets, selected]);

  const patch = (next: Partial<PetDraft>): void => {
    setPets((list) => list.map((pet) => (pet.id === selected ? { ...pet, ...next } : pet)));
  };

  const patchPhysics = (next: Partial<PhysicsParams>): void => setPhysics((prev) => ({ ...prev, ...next }));

  /** 保存（force = 用户在「配置已损坏」弹窗里确认强行重建） */
  const save = async (force = false): Promise<void> => {
    if (busy) return;
    if (pets.length === 0) {
      setMsg({ kind: 'err', text: '至少保留一只宠物' });
      return;
    }
    setBusy(true);
    setMsg({ kind: '', text: '' });
    try {
      const body: SaveBody = {
        pets,
        physics,
        font,
        whisperImageEnabled: globals.whisperImageEnabled,
        chatImageEnabled: globals.chatImageEnabled,
        confineToScreen: globals.confineToScreen,
        chatMemoryRounds: globals.chatMemoryRounds,
        chatImageLimit: globals.chatImageLimit,
        whisperModel: { provider: '', model: '' },
        chatModel: { provider: '', model: '' },
      };
      const merged = await request<Record<string, MainConfig>>(
        '/dsh-pet-7340/config' + (force === true ? '?force=1' : ''),
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      adopt(merged);
      setMsg({ kind: 'ok', text: '已保存，桌面宠物已按新配置重建' });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) {
        // 用户配置解析不了：先不写盘，让用户决定（取消 = 不动文件 / 确认 = 白名单重建）
        const path = (error as { body?: { userFile?: unknown } }).body?.userFile;
        setDialog({ kind: 'corrupt', path: typeof path === 'string' ? path : meta.user });
        return;
      }
      setMsg({ kind: 'err', text: `保存失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  /** 恢复默认（把包内默认配置整份写入用户配置） */
  const reset = async (): Promise<void> => {
    setBusy(true);
    setMsg({ kind: '', text: '' });
    try {
      const merged = await request<Record<string, MainConfig>>('/dsh-pet-7340/config', { method: 'POST' });
      adopt(merged);
      setMsg({ kind: 'ok', text: '已恢复默认配置' });
    } catch (error) {
      setMsg({ kind: 'err', text: `恢复失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const addPet = (): void => {
    const template = pets[0];
    if (!template) return;
    const id = nextId(pets);
    setPets((list) => [
      ...list,
      {
        ...template,
        id,
        // 新宠物默认名字 = 自己的 id（避免与模板同名，看着像没加成功）
        name: id,
        position: { ...template.position },
      },
    ]);
    setSelected(id);
  };

  const removePet = (): void => {
    if (pets.length <= 1) {
      setDialog({ kind: 'lastOne' });
      return;
    }
    setDialog({ kind: 'remove' });
  };

  const doRemove = (): void => {
    setPets((list) => {
      const next = list.filter((pet) => pet.id !== selected);
      setSelected(next[0]?.id ?? '');
      return next;
    });
    setDialog(null);
  };

  const openDataDir = async (): Promise<void> => {
    try {
      await request('/app/api/open-dir', { method: 'POST' });
    } catch (error) {
      setMsg({ kind: 'err', text: `打开目录失败：${error instanceof Error ? error.message : String(error)}` });
    }
  };

  if (loadState === 'loading') {
    return <div className="card">正在读取桌宠配置…</div>;
  }
  if (loadState === 'error') {
    return (
      <div className="card">
        <h2>读取失败</h2>
        <p className="hint">{msg.text}</p>
        <button className="btn" type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2>宠物</h2>
        <p className="hint">可以同时养多只，各自独立大小与位置。改完点最下方的「保存」即时生效。</p>

        <div className="pet-list">
          {pets.map((pet) => (
            <button
              key={pet.id}
              type="button"
              className={'pet-chip' + (pet.id === selected ? ' is-active' : '')}
              onClick={() => setSelected(pet.id)}
            >
              {pet.name || pet.id}
              <span className="pet-chip__meta">{Math.round(pet.size)}px</span>
            </button>
          ))}
          <button type="button" className="btn" onClick={addPet}>
            + 添加宠物
          </button>
          <button type="button" className="btn" onClick={removePet} disabled={!current}>
            删除
          </button>
        </div>

        {current ? (
          <>
            <div className="row">
              <label>名字</label>
              <input
                type="text"
                value={current.name}
                placeholder="悬浮时显示，也会加进 AI 人设"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>
            <div className="row">
              <label>大小</label>
              <div className="inline">
                <input
                  type="number"
                  min={SIZE_MIN}
                  max={SIZE_MAX}
                  value={current.size}
                  onChange={(event) => patch({ size: Number(event.target.value) })}
                />
                <span className="unit">px 宽（高度 = 宽 × 9/16）</span>
              </div>
            </div>
            <div className="row">
              <label>显示</label>
              <label className="chk">
                <input
                  type="checkbox"
                  checked={current.display === 'desktop'}
                  onChange={(event) => patch({ display: event.target.checked ? 'desktop' : 'none' })}
                />
                显示在桌面
              </label>
            </div>
            <div className="row">
              <label>位置</label>
              <div className="inline">
                <select
                  value={current.position.corner}
                  onChange={(event) =>
                    patch({ position: { ...current.position, corner: event.target.value as Corner } })
                  }
                >
                  {CORNERS.map((corner) => (
                    <option key={corner.id} value={corner.id}>
                      {corner.label}
                    </option>
                  ))}
                </select>
                <span className="unit">水平</span>
                <input
                  type="number"
                  value={current.position.marginX}
                  onChange={(event) =>
                    patch({ position: { ...current.position, marginX: Number(event.target.value) } })
                  }
                />
                <span className="unit">垂直</span>
                <input
                  type="number"
                  value={current.position.marginY}
                  onChange={(event) =>
                    patch({ position: { ...current.position, marginY: Number(event.target.value) } })
                  }
                />
                <span className="unit">px</span>
              </div>
            </div>

            <div className="row">
              <label>功能</label>
              <div className="switches">
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={current.balanceEnabled}
                    onChange={(event) => patch({ balanceEnabled: event.target.checked })}
                  />
                  余额动画
                </label>
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={current.whisperEnabled}
                    onChange={(event) => patch({ whisperEnabled: event.target.checked })}
                  />
                  碎碎念
                </label>
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={current.workStatusEnabled}
                    onChange={(event) => patch({ workStatusEnabled: event.target.checked })}
                  />
                  对话状态联动
                </label>
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={current.fixedEnabled}
                    onChange={(event) => patch({ fixedEnabled: event.target.checked })}
                  />
                  待在原地
                </label>
              </div>
            </div>
            <p className="hint">
              余额动画需要「本地服务」里配好对应服务商的密钥；碎碎念与对话用那里配置的模型；
              状态联动会在它回话时切「思考 / 成功 / 出错」；「待在原地」只是不让它自己走开，点播与拖拽照常。
            </p>
          </>
        ) : (
          <p className="hint">还没有宠物，点「添加宠物」创建一只。</p>
        )}
      </div>

      <div className="card">
        <h2>行为</h2>
        <div className="row">
          <label>配图</label>
          <div className="switches">
            <label className="chk">
              <input
                type="checkbox"
                checked={globals.whisperImageEnabled}
                onChange={(event) => setGlobals({ ...globals, whisperImageEnabled: event.target.checked })}
              />
              碎碎念配表情包
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={globals.chatImageEnabled}
                onChange={(event) => setGlobals({ ...globals, chatImageEnabled: event.target.checked })}
              />
              对话配表情包
            </label>
          </div>
        </div>
        <div className="row">
          <label>拖拽</label>
          <label className="chk">
            <input
              type="checkbox"
              checked={globals.confineToScreen}
              onChange={(event) => setGlobals({ ...globals, confineToScreen: event.target.checked })}
            />
            甩出去时锁定在当前屏幕（多显示器时不会飞到别的屏）
          </label>
        </div>
      </div>

      <div className="card">
        <h2>外观</h2>
        <div className="row">
          <label>字体</label>
          <select
            value={font.family}
            onChange={(event) => setFont({ ...font, family: event.target.value as FontFamilyId })}
          >
            {FONT_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {FONT_LABELS[preset.id] ?? preset.id}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>字号</label>
          <div className="inline">
            <input
              type="number"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={font.size}
              onChange={(event) => setFont({ ...font, size: Number(event.target.value) })}
            />
            <span className="unit">px（气泡与悬浮提示）</span>
          </div>
        </div>
        <div className="row">
          <label>缩放</label>
          <label className="chk">
            <input
              type="checkbox"
              checked={font.followPet}
              onChange={(event) => setFont({ ...font, followPet: event.target.checked })}
            />
            字号随宠物大小等比缩放
          </label>
        </div>
      </div>

      <div className="card">
        <h2>对话</h2>
        <p className="hint">模型与 API Key 在「本地服务」页签配置；这里只管上下文长度与配图。</p>
        <div className="row">
          <label>记忆轮数</label>
          <div className="inline">
            <input
              type="number"
              min={0}
              max={50}
              value={globals.chatMemoryRounds}
              onChange={(event) => setGlobals({ ...globals, chatMemoryRounds: Number(event.target.value) })}
            />
            <span className="unit">轮（0 = 不记上下文）</span>
          </div>
        </div>
        <div className="row">
          <label>配图上限</label>
          <div className="inline">
            <input
              type="number"
              min={0}
              max={20}
              value={globals.chatImageLimit}
              onChange={(event) => setGlobals({ ...globals, chatImageLimit: Number(event.target.value) })}
            />
            <span className="unit">张（0 = 不限制）</span>
          </div>
        </div>
      </div>

      <details className="card">
        <summary>拖拽手感（高级）</summary>
        <div className="row">
          <label>重力</label>
          <div className="inline">
            <input
              type="number"
              step={100}
              value={physics.gravity}
              onChange={(event) => patchPhysics({ gravity: Number(event.target.value) })}
            />
            <span className="unit">px/s²（0 = 无重力）</span>
          </div>
        </div>
        <div className="row">
          <label>弹性</label>
          <div className="inline">
            <input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={physics.restitution}
              onChange={(event) => patchPhysics({ restitution: Number(event.target.value) })}
            />
            <span className="unit">0~1（撞墙撞地的回弹比例）</span>
          </div>
        </div>
        <div className="row">
          <label>地面摩擦</label>
          <div className="inline">
            <input
              type="number"
              step={0.5}
              value={physics.groundFriction}
              onChange={(event) => patchPhysics({ groundFriction: Number(event.target.value) })}
            />
            <span className="unit">/s（越大停得越快）</span>
          </div>
        </div>
        <div className="row">
          <label>抛掷力度</label>
          <div className="inline">
            <input
              type="number"
              step={0.1}
              min={0.1}
              value={physics.throwPower}
              onChange={(event) => patchPhysics({ throwPower: Number(event.target.value) })}
            />
            <span className="unit">倍（1 = 默认手感）</span>
          </div>
        </div>
        <div className="row">
          <label>其它</label>
          <div className="switches">
            <label className="chk">
              <input
                type="checkbox"
                checked={physics.ceilingBounce}
                onChange={(event) => patchPhysics({ ceilingBounce: event.target.checked })}
              />
              碰到屏幕顶部反弹
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={physics.petCollision}
                onChange={(event) => patchPhysics({ petCollision: event.target.checked })}
              />
              多只宠物互相撞开
            </label>
          </div>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={() => setPhysics({ ...DEFAULT_PHYSICS })}>
            恢复默认手感
          </button>
        </div>
      </details>

      <div className="card">
        <h2>存储</h2>
        <dl className="kv">
          <dt>配置文件</dt>
          <dd>{meta.user ?? '（未知）'}</dd>
          <dt>自定义动画</dt>
          <dd>{meta.animations ?? '（未知）'}</dd>
        </dl>
        <p className="hint">
          把 VP9-alpha 的 <code>.webm</code> 放进自定义动画目录即为新动作，右键菜单可直接点播。
        </p>
        <div className="actions">
          <button className="btn" type="button" onClick={() => void openDataDir()}>
            打开数据目录
          </button>
          <button className="btn" type="button" onClick={() => setDialog({ kind: 'reset' })}>
            恢复默认配置
          </button>
        </div>
      </div>

      <div className="actions">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <button className="btn" type="button" disabled={busy} onClick={() => void load()}>
          放弃修改
        </button>
        {msg.text ? <span className={`status ${msg.kind}`}>{msg.text}</span> : null}
      </div>

      {dialog ? (
        <div className="overlay">
          <div className="modal">
            <h3>
              {dialog.kind === 'remove'
                ? '删除宠物'
                : dialog.kind === 'lastOne'
                  ? '至少保留一只'
                  : dialog.kind === 'reset'
                    ? '恢复默认配置'
                    : '配置文件已损坏'}
            </h3>
            <p>
              {dialog.kind === 'remove'
                ? `确定删除「${current?.name || selected}」吗？`
                : dialog.kind === 'lastOne'
                  ? '只剩这一只了，不能再删。想让它消失可以取消勾选「显示在桌面」。'
                  : dialog.kind === 'reset'
                    ? '会用内置默认配置覆盖当前配置（自定义动画与表情包文件不受影响）。'
                    : `无法解析 ${dialog.path ?? '用户配置文件'}。继续保存会用当前表单重建该文件，文件里其它手写内容将丢失。`}
            </p>
            <div className="actions">
              {dialog.kind === 'lastOne' ? (
                <button className="btn primary" type="button" onClick={() => setDialog(null)}>
                  知道了
                </button>
              ) : (
                <>
                  <button className="btn" type="button" onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    className="btn primary"
                    type="button"
                    onClick={() => {
                      const kind = dialog.kind;
                      setDialog(null);
                      if (kind === 'remove') doRemove();
                      else if (kind === 'reset') void reset();
                      else void save(true);
                    }}
                  >
                    {dialog.kind === 'remove' ? '删除' : '继续'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
