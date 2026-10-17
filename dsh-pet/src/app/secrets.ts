/**
 * 密钥的落盘加密（Electron `safeStorage` 之上的一层薄封装）。
 *
 * 为什么需要：`secrets.json` 里是用户的 API Key。`chmod 0600` 在 Windows 上是空操作
 * （只能影响只读位），文件实际是明文——同一台机器上的任何进程都能直接读。
 * Electron 自带 `safeStorage`（Windows 走 DPAPI、macOS 走 Keychain、Linux 走 libsecret），
 * 加密结果绑定当前用户，拷到别的机器/别的账号就解不开，这是"落盘也不裸奔"的最低成本方案。
 *
 * 兼容策略：
 *   - 新写入一律 `enc:v1:<base64>`；
 *   - 读到时**没有前缀**就按旧明文处理（升级前写下的文件照样能用），下次保存自动变成密文；
 *   - 解密失败（换机器 / 换账号 / 系统密钥环被重置）→ 视为"没配"，让用户重填，
 *     而不是让整个应用起不来。这一条必须显式，否则一个坏文件会把设置页也带崩。
 *
 * 为什么做成可注入的 codec：`local-config.ts` 是纯 Node 模块（测试里也直接跑），
 * 不能 import electron。主进程启动时把真正的 safeStorage 注入进来，测试里注入假实现。
 */

/** 加密实现（主进程注入 safeStorage；缺省 = 不加密） */
export interface SecretCodec {
  /** 当前环境是否支持加密（Linux 无密钥环时会返回 false） */
  available(): boolean;
  /** 明文 → base64 密文 */
  encrypt(plain: string): string;
  /** base64 密文 → 明文 */
  decrypt(encoded: string): string;
}

/** 密文前缀（带版本号：将来换算法可以并存） */
export const ENC_PREFIX = 'enc:v1:';

/** 缺省实现：不加密，原样存取（测试、或系统不支持时） */
const PLAIN_CODEC: SecretCodec = {
  available: () => false,
  encrypt: (plain) => plain,
  decrypt: (encoded) => encoded,
};

let codec: SecretCodec = PLAIN_CODEC;

/** 注入加密实现（主进程在 app ready 后调用；测试可注入假实现） */
export function setSecretCodec(next: SecretCodec): void {
  codec = next;
}

/** 当前是否真的在加密落盘（设置页与日志用来说明状态） */
export function encryptionAvailable(): boolean {
  try {
    return codec.available();
  } catch {
    return false;
  }
}

/**
 * 落盘前封装：支持加密则加前缀，否则原样返回。
 * @param plain 明文密钥
 */
export function sealSecret(plain: string): string {
  if (!plain) return plain;
  try {
    if (!codec.available()) return plain;
    return ENC_PREFIX + codec.encrypt(plain);
  } catch {
    // 加密失败不该让"保存设置"整个失败：退化成明文，下次启动再试
    return plain;
  }
}

/**
 * 读取时拆封：旧明文原样返回；解不开返回空串（视为未配置）。
 * @param stored 文件里的值
 */
export function openSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored; // 升级前的明文
  try {
    return codec.decrypt(stored.slice(ENC_PREFIX.length));
  } catch {
    return '';
  }
}
