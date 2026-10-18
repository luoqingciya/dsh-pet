/**
 * 设置页的「本地服务」面板：服务商 / 模型 / API Key / 余额 / 通知开关。
 *
 * 这一块是**本地应用独有**的——DSH 里这些都由 DSH 自己管（模型选择器、凭据库、通知引擎），
 * 插件不需要也不该重复实现。脱离 DSH 之后没有宿主可依赖，配置就必须有一个能点的入口，
 * 否则用户只能手改 JSON。
 *
 * 数据通路：全部走 `/app/api/*`（同 origin），见 `../web-ui.ts`。密钥**只写不读**：
 * 服务端只回「有没有配」，页面也从不保存明文到任何地方（输入框提交后立即清空）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

/** 端点（与 host 侧 AppEndpoint 同构，仅本页用到的字段） */
interface EndpointView {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyRef: string;
  models: string[];
  keyConfigured: boolean;
}

/** `GET /app/api/config` 的配置视图 */
interface ConfigView {
  provider: string;
  model: string;
  balanceProvider: string;
  endpoints: EndpointView[];
  notify: { chatReply: boolean; balanceAlert: boolean };
  /** 启动时检查新版本（只提示，不自动安装） */
  updateCheck: boolean;
  keys: Record<string, boolean>;
}

/** 运行时信息 */
interface RuntimeView {
  port: number;
  version: string;
  dataDir: string;
  electron: string;
}

/** 余额服务商（服务端下发，避免页面里再抄一份 id 表） */
interface BalanceProvider {
  id: string;
  name: string;
  keyRef: string;
}

/** 页面草稿（= 可编辑状态） */
interface Draft {
  provider: string;
  model: string;
  balanceProvider: string;
  endpoints: EndpointView[];
  notify: { chatReply: boolean; balanceAlert: boolean };
  updateCheck: boolean;
}

/** 视图 → 草稿 */
function draftOf(view: ConfigView): Draft {
  return {
    provider: view.provider,
    model: view.model,
    balanceProvider: view.balanceProvider,
    endpoints: view.endpoints.map((endpoint) => ({ ...endpoint, models: [...endpoint.models] })),
    notify: { ...view.notify },
    updateCheck: view.updateCheck !== false,
  };
}

/** 统一的 JSON 请求 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error((body as { message?: string })?.message ?? `HTTP ${res.status}`);
  return body as T;
}

/** 需要填写的密钥名（端点 + 余额服务商，去重保序） */
function keyNamesOf(draft: Draft, balanceProviders: BalanceProvider[]): string[] {
  const names: string[] = [];
  const push = (name: string): void => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const endpoint of draft.endpoints) push(endpoint.apiKeyRef);
  for (const provider of balanceProviders) push(provider.keyRef);
  return names;
}

export function LocalPanel(): React.ReactElement {
  const [view, setView] = useState<ConfigView | undefined>(undefined);
  const [runtime, setRuntime] = useState<RuntimeView | undefined>(undefined);
  const [balanceProviders, setBalanceProviders] = useState<BalanceProvider[]>([]);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: '' | 'ok' | 'err'; text: string }>({ kind: '', text: '' });
  const [testResult, setTestResult] = useState<{ kind: '' | 'ok' | 'err'; text: string }>({ kind: '', text: '' });
  /**
   * 各服务商的模型清单（`GET /dsh-pet-7340/models`）——只用来给「模型」输入框做下拉建议。
   *
   * 从前这个接口在应用里**一个消费方都没有**：模型只能盲填，端点明明支持 `/models`
   * 却没人去问。现在拉一次填进 datalist；拉不到（端点没实现 / 网络不通）就静默降级成
   * 纯手填，不影响保存。
   */
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  /** 手动检查更新的结果（托盘菜单也有入口，但那边是原生控件、字号小；设置页这个更显眼） */
  const [updateResult, setUpdateResult] = useState<
    undefined | { kind: 'checking' | 'newer' | 'latest' | 'error'; version?: string; url?: string; message?: string }
  >(undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await request<{
        config: ConfigView;
        runtime: RuntimeView;
        balanceProviders: BalanceProvider[];
      }>('/app/api/config');
      setView(data.config);
      setRuntime(data.runtime);
      setBalanceProviders(data.balanceProviders);
      setDraft(draftOf(data.config));
      setKeys({});
      setCleared([]);
    } catch (error) {
      setMessage({ kind: 'err', text: `读取配置失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 拉模型清单（只做输入建议；失败静默——手填永远可用） */
  const loadModelOptions = useCallback(async (): Promise<void> => {
    try {
      const data = await request<{ providers: Array<{ id: string; models: Array<{ id: string }> }> }>(
        '/dsh-pet-7340/models',
      );
      const map: Record<string, string[]> = {};
      for (const provider of data.providers ?? []) {
        map[provider.id] = (provider.models ?? []).map((model) => model.id).filter(Boolean);
      }
      setModelOptions(map);
    } catch {
      /* 拉不到就只保留手填 */
    }
  }, []);

  useEffect(() => {
    void loadModelOptions();
  }, [loadModelOptions]);

  const keyNames = useMemo(() => (draft ? keyNamesOf(draft, balanceProviders) : []), [draft, balanceProviders]);

  const patch = (next: Partial<Draft>): void => setDraft((prev) => (prev ? { ...prev, ...next } : prev));

  const patchEndpoint = (id: string, next: Partial<EndpointView>): void => {
    setDraft((prev) =>
      prev ? { ...prev, endpoints: prev.endpoints.map((e) => (e.id === id ? { ...e, ...next } : e)) } : prev,
    );
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setMessage({ kind: '', text: '' });
    try {
      // 密钥：只提交用户本次输入的值；显式「清除」的提交 null
      const keyPatch: Record<string, string | null> = {};
      for (const [name, value] of Object.entries(keys)) if (value.trim()) keyPatch[name] = value.trim();
      for (const name of cleared) if (!keyPatch[name]) keyPatch[name] = null;
      const data = await request<{ config: ConfigView }>('/app/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            provider: draft.provider,
            model: draft.model,
            balanceProvider: draft.balanceProvider,
            endpoints: draft.endpoints.map(({ id, name, baseUrl, apiKeyRef, models }) => ({
              id,
              name,
              baseUrl,
              apiKeyRef,
              models,
            })),
            notify: draft.notify,
            updateCheck: draft.updateCheck,
          },
          keys: keyPatch,
        }),
      });
      setView(data.config);
      setDraft(draftOf(data.config));
      setKeys({});
      setCleared([]);
      setMessage({ kind: 'ok', text: '已保存（立即生效，无需重启）' });
    } catch (error) {
      setMessage({ kind: 'err', text: `保存失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setTestResult({ kind: '', text: '正在请求模型…' });
    try {
      const result = await request<{ ok: boolean; text?: string; message?: string; ms?: number }>('/app/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: draft.provider, model: draft.model }),
      });
      setTestResult(
        result.ok
          ? { kind: 'ok', text: `连通正常（${result.ms ?? 0}ms）：${result.text ?? ''}` }
          : { kind: 'err', text: `失败：${result.message ?? '未知原因'}` },
      );
    } catch (error) {
      setTestResult({ kind: 'err', text: `失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  /** 手动查一次新版本（与托盘「检查更新」走同一个后端） */
  const checkUpdate = async (): Promise<void> => {
    setUpdateResult({ kind: 'checking' });
    try {
      const result = await request<{
        kind: 'newer' | 'latest' | 'error';
        version?: string;
        url?: string;
        message?: string;
      }>('/app/api/update-check', { method: 'POST' });
      setUpdateResult(result);
    } catch (error) {
      setUpdateResult({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const openDir = async (): Promise<void> => {
    try {
      await request('/app/api/open-dir', { method: 'POST' });
    } catch (error) {
      setMessage({ kind: 'err', text: `打开目录失败：${error instanceof Error ? error.message : String(error)}` });
    }
  };

  if (!draft || !view) {
    return <div className="card">{message.text || '正在加载本地服务配置…'}</div>;
  }

  const currentEndpoint = draft.endpoints.find((endpoint) => endpoint.id === draft.provider);
  const keyState = (name: string): boolean => {
    if (cleared.includes(name)) return false;
    if (keys[name]?.trim()) return true;
    return view.keys[name] === true;
  };

  return (
    <div>
      <div className="card">
        <h2>模型服务</h2>
        <p className="hint">
          碎碎念与对话走这里配置的 OpenAI 兼容接口；余额查询复用同一个服务商的密钥（也可单独指定）。
        </p>

        <div className="row">
          <label>服务商</label>
          <select
            value={draft.provider}
            onChange={(event) => {
              const provider = event.target.value;
              const endpoint = draft.endpoints.find((item) => item.id === provider);
              patch({ provider, model: endpoint?.models[0] ?? draft.model });
            }}
          >
            {draft.endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.name}
              </option>
            ))}
          </select>
        </div>

        <div className="row">
          <label>模型</label>
          <div style={{ display: 'flex', gap: 8, flex: 1 }}>
            <input
              type="text"
              list="dsh-pet-model-options"
              value={draft.model}
              placeholder="如 deepseek-flash / qwen-plus"
              onChange={(event) => patch({ model: event.target.value })}
            />
            {/* 建议来自端点 /models；没有建议时 datalist 为空，输入框退化成纯手填 */}
            <datalist id="dsh-pet-model-options">
              {(modelOptions[draft.provider] ?? []).map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </div>
        </div>
        {(modelOptions[draft.provider] ?? []).length > 0 ? (
          <p className="hint">
            下拉建议来自端点自己的 <code>/models</code>（共 {modelOptions[draft.provider]!.length}{' '}
            个），也可以直接手填。
          </p>
        ) : (
          <p className="hint">
            可以直接手填模型名；端点支持 <code>/models</code> 时会自动列出建议。
          </p>
        )}

        {currentEndpoint ? (
          <>
            <div className="row">
              <label>接口地址</label>
              <input
                type="text"
                value={currentEndpoint.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(event) => patchEndpoint(currentEndpoint.id, { baseUrl: event.target.value })}
              />
            </div>
            <div className="row">
              <label>模型清单</label>
              <input
                type="text"
                value={currentEndpoint.models.join(', ')}
                placeholder="留空则自动从 /models 拉取"
                onChange={(event) =>
                  patchEndpoint(currentEndpoint.id, {
                    models: event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
          </>
        ) : null}

        <div className="actions">
          <button className="btn" type="button" disabled={busy} onClick={() => void test()}>
            测试连通
          </button>
          {testResult.text ? <span className={`status ${testResult.kind}`}>{testResult.text}</span> : null}
        </div>
      </div>

      <div className="card">
        <h2>API Key</h2>
        <p className="hint">
          保存在本机 <code>secrets.json</code>，用系统密钥加密（Windows DPAPI / macOS 钥匙串），不会上传。
          已配置的密钥不回显，留空表示不修改。
        </p>
        {keyNames.length === 0 ? <p className="hint">当前端点不需要密钥。</p> : null}
        {keyNames.map((name) => (
          <div className="row" key={name}>
            <label>
              {name} {keyState(name) ? <span className="pill ok">已配置</span> : <span className="pill">未配置</span>}
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                value={keys[name] ?? ''}
                placeholder={view.keys[name] ? '已配置，留空不修改' : '粘贴 API Key'}
                onChange={(event) => setKeys((prev) => ({ ...prev, [name]: event.target.value }))}
              />
              {keyState(name) ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setCleared((prev) => (prev.includes(name) ? prev : [...prev, name]));
                    setKeys((prev) => ({ ...prev, [name]: '' }));
                  }}
                >
                  清除
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>余额查询</h2>
        <p className="hint">宠物头顶气泡按余额/额度分档播放动画。服务商不支持时只弹文字说明，不会静默。</p>
        <div className="row">
          <label>余额服务商</label>
          <select value={draft.balanceProvider} onChange={(event) => patch({ balanceProvider: event.target.value })}>
            <option value="">跟随模型服务商（{draft.provider}）</option>
            {balanceProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>刷新周期</label>
          <span className="status">在配置文件 eventsRefreshSec.balance 里调整（默认 1800 秒）</span>
        </div>
      </div>

      <div className="card">
        <h2>系统通知</h2>
        <p className="hint">宠物回话完成、生成失败、余额告急时弹系统通知（走系统原生通知，不依赖窗口焦点）。</p>
        <div className="row">
          <label>对话结果</label>
          <label className="chk">
            <input
              type="checkbox"
              checked={draft.notify.chatReply}
              onChange={(event) => patch({ notify: { ...draft.notify, chatReply: event.target.checked } })}
            />
            回话完成或生成失败时弹系统通知
          </label>
        </div>
        <div className="row">
          <label>余额告急</label>
          <label className="chk">
            <input
              type="checkbox"
              checked={draft.notify.balanceAlert}
              onChange={(event) => patch({ notify: { ...draft.notify, balanceAlert: event.target.checked } })}
            />
            余额/额度已用 ≥ 90% 时提醒一次
          </label>
        </div>
      </div>

      <div className="card">
        <h2>更新</h2>
        <p className="hint">
          只<strong>提示</strong>有新版本，点通知打开下载页手动替换——不会自动下载或覆盖文件（免安装版没有安装器，
          运行中替换 exe 反而更容易把应用弄坏）。也可以随时用托盘「检查更新」手动查一次。
        </p>
        <div className="row">
          <label>自动检查</label>
          <label className="chk">
            <input
              type="checkbox"
              checked={draft.updateCheck}
              onChange={(event) => patch({ updateCheck: event.target.checked })}
            />
            启动后检查一次新版本（之后每 12 小时一次；失败静默）
          </label>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={() => void checkUpdate()}>
            立即检查
          </button>
          {updateResult ? (
            <span
              className={`status ${updateResult.kind === 'error' ? 'err' : updateResult.kind === 'newer' ? 'ok' : ''}`}
            >
              {updateResult.kind === 'checking'
                ? '正在检查…'
                : updateResult.kind === 'newer'
                  ? `有新版本 v${updateResult.version}：`
                  : updateResult.kind === 'latest'
                    ? `已是最新（v${updateResult.version}）`
                    : `检查失败：${updateResult.message ?? '未知原因'}`}
            </span>
          ) : null}
          {updateResult?.kind === 'newer' && updateResult.url ? (
            // target=_blank：设置窗的 setWindowOpenHandler 会把外链交给系统浏览器打开
            <a className="btn" href={updateResult.url} target="_blank" rel="noreferrer">
              打开下载页
            </a>
          ) : null}
        </div>
      </div>

      <div className="actions">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <button className="btn" type="button" disabled={busy} onClick={() => void load()}>
          重新读取
        </button>
        <button className="btn" type="button" onClick={() => void openDir()}>
          打开数据目录
        </button>
        {message.text ? <span className={`status ${message.kind}`}>{message.text}</span> : null}
      </div>

      {runtime ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>运行时</h2>
          <dl className="kv">
            <dt>版本</dt>
            <dd>dsh-pet {runtime.version}</dd>
            <dt>本地服务</dt>
            <dd>http://127.0.0.1:{runtime.port}/dsh-pet-7340/</dd>
            <dt>数据目录</dt>
            <dd>{runtime.dataDir}</dd>
            <dt>Electron</dt>
            <dd>{runtime.electron}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
