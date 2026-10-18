/**
 * 版本检查（自动更新的「A 方案」：只提示，不自动替换文件）。
 *
 * 为什么不做自动替换：免安装版没有安装器，electron-builder 的 portable 目标**官方不支持**
 * 自动更新；Windows 又替换不了运行中的 exe，必须"退出后换文件"——那等于自己重写一个安装器，
 * 断电/杀软/权限任一失败都会留下"打不开的应用"。所以这里只做三件事：
 *   ① 启动后（延迟）查一次 GitHub 的 latest release，之后每 12 小时一次；
 *   ② 有新版 → 弹一条原生通知，点一下打开下载页；
 *   ③ 托盘「检查更新」可手动触发，结果（最新 / 有新版 / 检查失败）都会明确告知。
 *
 * 纯逻辑 + 注入 fetch：本模块不碰 electron，能在 node:test 里直接跑（见 update-check.test.ts）。
 *
 * 网络口径：**失败一律静默**（自动检查时），因为国内访问 api.github.com 经常不通，而"每次
 * 启动弹一句检查失败"是纯打扰。需要镜像/自建源时用 `DSH_PET_UPDATE_API` 指向一个返回
 * `{tag_name, html_url}`（GitHub 形状）或 `{version, url}`（简化形状）的地址。
 */

/** 上游仓库（README / 徽章 / Release 都指向这里） */
export const UPDATE_REPO = 'luoqingciya/dsh-pet';

/** 下载页（检查失败时也能给用户一个落脚点） */
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases/latest`;

/** GitHub latest release 接口（未认证 60 次/小时，12 小时一次远够） */
const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** 检查结果：有新版 / 已是最新 / 查不了（网络、限流、响应格式） */
export type UpdateCheckResult =
  | { kind: 'newer'; version: string; url: string }
  | { kind: 'latest'; version: string }
  | { kind: 'error'; message: string };

/** 解析 `v1.2.3` / `1.2.3` / `1.2.3-beta.1` 的数字段；非法返回 undefined */
export function versionCore(raw: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** 是否预发布（`1.2.3-beta.1` 这类）：同数字段时它比正式版**旧** */
function isPrerelease(raw: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(
    String(raw ?? '')
      .trim()
      .replace(/^v/, ''),
  );
}

/**
 * 比较两个版本号：> 0 表示 a 比 b 新，0 表示相同（预发布视为更低）。
 * 解析不了的一方按"最旧"处理——宁可不提示，也不要在版本号格式怪时误报。
 */
export function compareVersions(a: string, b: string): number {
  const ca = versionCore(a);
  const cb = versionCore(b);
  if (!ca && !cb) return 0;
  if (!ca) return -1;
  if (!cb) return 1;
  for (let index = 0; index < 3; index += 1) {
    const diff = (ca[index] ?? 0) - (cb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  const pa = isPrerelease(a);
  const pb = isPrerelease(b);
  if (pa === pb) return 0;
  return pa ? -1 : 1;
}

/**
 * 解析 latest release 响应。
 *
 * 同时接受两种形状（自建镜像可以只放一个静态 JSON）：
 *   - GitHub：`{ tag_name: "v0.7.0", html_url: "…", draft, prerelease }`
 *   - 简化：  `{ version: "0.7.0", url: "…" }`
 *
 * draft / prerelease 一律忽略（`releases/latest` 本来就不含，但镜像可能照抄整个列表）。
 */
export function parseLatestRelease(body: unknown): { version: string; url: string } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  if (o.draft === true || o.prerelease === true) return undefined;
  const version = String(o.tag_name ?? o.version ?? '')
    .trim()
    .replace(/^v/, '');
  if (!versionCore(version)) return undefined;
  const url = String(o.html_url ?? o.url ?? '').trim();
  return { version, url: /^https?:\/\//.test(url) ? url : RELEASES_PAGE };
}

/** 检查地址：默认 GitHub API，可用 `DSH_PET_UPDATE_API` 覆盖（镜像 / 自建源 / 测试） */
export function updateApiUrl(): string {
  const custom = String(process.env.DSH_PET_UPDATE_API ?? '').trim();
  return custom || RELEASES_API;
}

/**
 * 查一次有没有新版本。
 *
 * @param options.current 当前版本（`appVersion()` 的返回值）
 * @param options.url 检查地址（缺省走 {@link updateApiUrl}）
 * @param options.fetchImpl 注入的 fetch（测试用）
 * @param options.timeoutMs 超时；桌面启动路径上不能让一次网络请求挂太久
 */
export async function checkForUpdate(options: {
  current: string;
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<UpdateCheckResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.url ?? updateApiUrl();
  try {
    const res = await doFetch(url, {
      // GitHub API 要求带 UA，否则 403
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-pet-update-check' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
    if (!res.ok) return { kind: 'error', message: `检查接口返回 HTTP ${res.status}` };
    const latest = parseLatestRelease(await res.json());
    if (!latest) return { kind: 'error', message: '检查接口的响应格式不认识' };
    if (compareVersions(latest.version, options.current) > 0) {
      return { kind: 'newer', version: latest.version, url: latest.url };
    }
    return { kind: 'latest', version: latest.version };
  } catch (error) {
    // 断网 / DNS / 超时 / JSON 解析失败：统一成一句人话，调用方决定要不要打扰用户
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: message.includes('timeout') ? '连接超时' : message };
  }
}
