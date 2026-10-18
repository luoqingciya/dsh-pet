/**
 * 命令行端口解析（应用本体用）。
 *
 * 为什么单独成文件：`main.ts` 一 import 就会把 `electron` 拖进来，node:test 里根本没法加载，
 * 于是"解析得对不对"只能靠源码守卫（弱）。把它拆成零依赖的纯函数就能直接单测。
 *
 * 与 `launch.ts` 的 `parsePort` **刻意不是同一个**：
 *   - 启动器（`npm run app` / `dsh-pet.cmd`）是**面向用户的 CLI**：只认 `--port`，遇到别的参数
 *     直接报错（避免"打错字却静默忽略"）；
 *   - 应用本体跑在 Electron 里，`process.argv` 混着 Electron/Chromium 自己的一堆开关
 *     （`--user-data-dir`、`--allow-file-access-from-files`…）以及 app 路径，**必须宽松**：
 *     只挑出 `--port`，其余一律不管。否则 `dsh-pet.exe --user-data-dir=...` 会被判成"未知参数"。
 *
 * 优先级（调用方决定）：命令行 > `DSH_PET_APP_PORT` > 默认 7340。
 */

/** 解析结果：port 缺省 = 没传；error 存在 = 传了但非法（调用方告警后回落） */
export interface PortArgResult {
  port?: number;
  /** 传了 `--port` 但值不合法时的原文（用于告警文案） */
  raw?: string;
}

/**
 * 从 argv 里挑出 `--port <n>` / `--port=<n>`。
 *
 * @param argv 完整 argv（可含 exe 路径、app 路径与 Electron 自己的开关——只找 `--port`）
 * @returns 合法 → `{ port }`；没传 → `{}`；传了但非法 → `{ raw }`（**不抛错**：起不来比端口不对更糟）
 */
export function portFromArgv(argv: readonly string[]): PortArgResult {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg !== '--port' && !arg.startsWith('--port=')) continue;
    const raw = arg === '--port' ? String(argv[index + 1] ?? '') : arg.slice('--port='.length);
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) return { port: value };
    return { raw };
  }
  return {};
}
