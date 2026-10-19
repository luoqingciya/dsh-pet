/**
 * 开机自启的**纯逻辑**（不 import electron，可单测）：命令行转义、Linux 的 .desktop 内容。
 *
 * 拆出来的原因：Linux 分支在 Windows 机器上跑不到，而它唯一的产物就是一串文本——
 * 把这串文本的生成做成纯函数，单元测试就能把格式钉住；真正落盘的逻辑留在 `autostart.ts`。
 */
import { homedir } from 'node:os';
import { posix } from 'node:path';

/** 登录时要执行的那条命令 */
export interface LoginCommand {
  /** 可执行文件绝对路径 */
  path: string;
  /** 启动参数（源码态是主进程脚本） */
  args: string[];
}

/**
 * Linux 的 autostart 文件路径（XDG Base Directory 规范）。
 *
 * 用 `posix.join` 而不是 `join`：这个路径**永远是 Linux 的**，不随宿主平台变——
 * 否则在 Windows 上跑单测会拼出 `C:\…\autostart\dsh-petNG.desktop` 这种根本不会用到的形状。
 */
export function linuxAutostartFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME || posix.join(home, '.config');
  return posix.join(configHome, 'autostart', 'dsh-petNG.desktop');
}

/**
 * 按 Desktop Entry 规范转义一个 Exec 参数。
 *
 * 规则（freedesktop 规范 "The Exec key"）：参数含保留字符时用双引号包住，内部
 * `"` `\` `` ` `` `$` 用反斜杠转义；`%` 是字段码前缀，要写成 `%%`。
 * Windows 路径里的反斜杠也必须转义——不转义的话 `C:\Users\…` 会被当成转义序列吃掉。
 */
export function quoteExecArg(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/%/g, '%%');
  return `"${escaped}"`;
}

/** 生成 .desktop 内容（Linux 分支的唯一产物） */
export function buildDesktopEntry(command: LoginCommand): string {
  const exec = [command.path, ...command.args].map(quoteExecArg).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=dsh-petNG',
    'Comment=桌面宠物（dsh-petNG）',
    `Exec=${exec}`,
    // 没有终端窗口；也不是要在桌面/菜单里展示的条目
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}
