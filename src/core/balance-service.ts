/**
 * 余额查询：**宿主侧唯一的查询点**。
 *
 * 改造前是每个客户端各自按自己的定时器去查（每个窗口一个）：同一份外部 API 被重复请求、
 * 不同窗口还可能看到新旧不一致的数据。现在只有这里查，所有窗口都从 `/state` 读同一份结果。
 *
 * 失败也写进 S（reason 区分 unsupported / credential-missing / fetch-error）——余额不可用要弹
 * 文字说明气泡，不能静默；意外异常同样落成 fetch-error，不吞。
 */
import { credentialRef } from './standalone/credentials';
import { queryBalance } from './balance/index';
import type { PollStateStore } from './state';

export interface BalanceServiceOptions {
  state: PollStateStore;
  /** 当前对话的服务商（`ctx.agentDefaultModel.currentSelection().provider`） */
  currentProvider: () => string;
  /** 余额服务商覆盖（`ctx.petBalanceProvider`）：对话用 A、余额查 B；缺省跟随对话 */
  balanceProvider?: () => string;
  /** 解析凭证（`ctx.credentials.resolve`） */
  resolveCredential: (ref: unknown) => Promise<string | undefined>;
}

export interface BalanceService {
  /**
   * 刷新余额并写入 S。
   * @param manual 这次刷新是不是"用户要的"（/balance 命令、桌面「查看余额」菜单）。
   *   标记随数据一起写进叶子：只有宿主知道是谁要的，前端据此决定余额不可用时要不要**必弹**
   *   文字说明（周期刷新则只在原因变化时弹一次，免得反复刷屏）。
   */
  refresh(manual?: boolean): Promise<void>;
}

export function createBalanceService(options: BalanceServiceOptions): BalanceService {
  const { state, currentProvider, balanceProvider, resolveCredential } = options;

  return {
    async refresh(manual = false): Promise<void> {
      const mark = <T>(v: T): T | (T & { manual: true }) => (manual ? { ...v, manual: true } : v);
      try {
        const provider = currentProvider();
        // 余额服务商：默认跟随当前对话的模型。本地应用允许「对话用 A、余额查 B」——
        // 宿主若提供 petBalanceProvider 能力就优先用它，空串回落当前对话的服务商。
        const balanceProviderId = balanceProvider ? String(balanceProvider() || provider) : provider;
        const result = await queryBalance(balanceProviderId, async (ref) => {
          const value = await resolveCredential(credentialRef(ref));
          return value;
        });
        state.writeSection('balance', mark(result));
      } catch (e) {
        state.writeSection(
          'balance',
          mark({
            ok: false,
            provider: 'unknown',
            reason: 'fetch-error',
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    },
  };
}
