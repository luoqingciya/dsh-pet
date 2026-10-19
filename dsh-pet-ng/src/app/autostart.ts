/**
 * 开机自启（登录时启动）。
 *
 * 对外只有一个开关，三个平台三条落地路径：
 *
 *   - **Windows**：`app.setLoginItemSettings()` → 写 `HKCU\…\CurrentVersion\Run` 下名为
 *     `dsh-petNG` 的一项（值是 `"<exe>" <args>`）；
 *   - **macOS**：同一个 API → 系统「登录项」（Login Items）；
 *   - **Linux**：Electron 这个 API 是**空实现**（文档只写了 macOS / Windows），所以改按
 *     XDG autostart 规范写 `$XDG_CONFIG_HOME/autostart/dsh-petNG.desktop`
 *     —— GNOME / KDE / XFCE / Cinnamon 都认这个目录。转义与内容生成在 `autostart-entry.ts`（纯函数、可单测）。
 *
 * **源码态要带主进程脚本**：那时 `process.execPath` 是 `electron.exe`，光注册它开机会拉起一个
 * 空壳（没有任何窗口）。打包版 `app.isPackaged === true`，exe 自己就是应用，不需要参数。
 *
 * 状态**以系统为准**：每次读 `getLoginItemSettings()` / 看 .desktop 在不在，不另存一份偏好。
 * 否则用户在「任务管理器 → 启动」里禁掉之后，设置页还会显示"已开启"，那就成了撒谎。
 * 代价：应用换过安装位置后，旧条目里记的还是老路径，需要用户再点一次开关。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { app } from 'electron';

import { buildDesktopEntry, linuxAutostartFile, type LoginCommand } from './autostart-entry';

export { buildDesktopEntry, linuxAutostartFile, quoteExecArg } from './autostart-entry';
export type { LoginCommand } from './autostart-entry';

/** 自启开关的对外状态 */
export interface AutoStartState {
  /** 当前平台是否实现了（三平台都实现；留这个字段是为了将来真的遇到不支持的平台时能如实说） */
  supported: boolean;
  /** 系统里此刻是否真的会开机自启 */
  enabled: boolean;
  /** 写在哪里（设置页展示 + 排障用）：注册表项 / 登录项 / .desktop 路径 */
  target: string;
  /** 登录时实际执行的命令行（源码态会带主进程脚本，设置页要据此提示"别挪仓库"） */
  command: string;
  /** 源码态：登录项指向 electron + 仓库里的脚本，移动/删除仓库后就失效 */
  dev: boolean;
  /** 不可用的原因（`supported=false` 时才有） */
  reason?: string;
}

/**
 * 登录时要跑的命令。
 *
 * 源码态（`npm run app`）要把主进程脚本一起注册进去——`process.execPath` 那时是
 * `electron.exe`，光注册它，登录后只会拉起一个没有任何窗口的空壳。
 *
 * 脚本位置不能只看 `argv[1]`：Chromium 的开关会插在它前面（playwright 起的实例就是
 * `electron.exe --inspect=0 --remote-debugging-port=0 <脚本> …`，实测踩过——注册出来的是
 * 一条不带脚本的裸 exe）。所以先找像脚本的那个，再退一步取第一个非开关参数。
 */
export function loginCommand(): LoginCommand {
  if (app.isPackaged) return { path: process.execPath, args: [] };
  const rest = process.argv.slice(1);
  const script =
    rest.find((arg) => !arg.startsWith('-') && /\.(?:c|m)?js$/i.test(arg)) ?? rest.find((arg) => !arg.startsWith('-'));
  return { path: process.execPath, args: script ? [script] : [] };
}

/** 当前平台是否支持（三平台都实现了；未知平台如实报 false） */
function platformSupported(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';
}

/** 读当前状态（以系统为准） */
export function readAutoStart(): AutoStartState {
  if (!platformSupported()) {
    return {
      supported: false,
      enabled: false,
      target: '',
      command: '',
      dev: !app.isPackaged,
      reason: `当前平台（${process.platform}）没有实现开机自启`,
    };
  }
  const cmd = loginCommand();
  const command = [cmd.path, ...cmd.args].join(' ');
  const dev = !app.isPackaged;
  if (process.platform === 'linux') {
    const file = linuxAutostartFile();
    return { supported: true, enabled: existsSync(file), target: file, command, dev };
  }
  const { openAtLogin } = app.getLoginItemSettings({ path: cmd.path, args: cmd.args });
  return {
    supported: true,
    enabled: openAtLogin,
    // 值名由 Electron 按 AppUserModelID 生成（源码态实测是 `electron.app.Electron`，
    // 打包版随 productName 变），JS 侧拿不到，所以这里只报注册表位置、不编一个可能错的名字。
    target:
      process.platform === 'darwin'
        ? '系统设置 → 通用 → 登录项'
        : 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    command,
    dev,
  };
}

/**
 * 打开/关闭自启。返回写完之后**重新读出来的**状态（不假设写一定成功）。
 * 失败直接抛（路由层会把它变成 400 + 消息），不做静默降级。
 */
export function writeAutoStart(enabled: boolean): AutoStartState {
  const state = readAutoStart();
  if (!state.supported) throw new Error(state.reason ?? '当前平台不支持开机自启');

  if (process.platform === 'linux') {
    const file = linuxAutostartFile();
    if (enabled) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buildDesktopEntry(loginCommand()), { mode: 0o644 });
    } else {
      rmSync(file, { force: true });
    }
    return readAutoStart();
  }

  const command = loginCommand();
  // 源码态找不到脚本就干脆别注册：写一条裸 electron.exe 进去，登录后只会弹一个空壳，
  // 比"没开"更难排查
  if (!app.isPackaged && command.args.length === 0) {
    throw new Error('源码态找不到主进程脚本，无法注册开机自启（请用 npm run app 启动后再试）');
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // macOS 忽略这两个字段（登录项按 app bundle 记），Windows 靠它们定位到具体那一条
    path: command.path,
    args: command.args,
  });
  return readAutoStart();
}
