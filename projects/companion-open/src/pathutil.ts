/**
 * pathutil.ts — Windows 路径大小写比较助手
 *
 * Windows 上同一目录可能以不同大小写形式出现：
 * - `vscode.Uri.fsPath` / `context.storageUri.fsPath` 返回小写盘符 `c:\...`
 * - `process.env.APPDATA`、`os.homedir()`、fs.readdirSync 返回真实大小写 `C:\...`
 * `path.normalize` 只统一分隔符、不折叠大小写，直接做字符串相等/Set 去重会把
 * 同一目录当成两个目录 → 会话列表重复、pinned 比较失效、每 tick 重绑定。
 */
import * as path from 'path';

/** 归一化为比较键：normalize 后在 win32 上转小写（NTFS 大小写不敏感）。 */
export function pathKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** 两个路径是否指向同一位置（Windows 下忽略大小写）。 */
export function samePath(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return a === b;
  return pathKey(a) === pathKey(b);
}
