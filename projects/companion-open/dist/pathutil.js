"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.pathKey = pathKey;
exports.samePath = samePath;
/**
 * pathutil.ts — Windows 路径大小写比较助手
 *
 * Windows 上同一目录可能以不同大小写形式出现：
 * - `vscode.Uri.fsPath` / `context.storageUri.fsPath` 返回小写盘符 `c:\...`
 * - `process.env.APPDATA`、`os.homedir()`、fs.readdirSync 返回真实大小写 `C:\...`
 * `path.normalize` 只统一分隔符、不折叠大小写，直接做字符串相等/Set 去重会把
 * 同一目录当成两个目录 → 会话列表重复、pinned 比较失效、每 tick 重绑定。
 */
const path = __importStar(require("path"));
/** 归一化为比较键：normalize 后在 win32 上转小写（NTFS 大小写不敏感）。 */
function pathKey(p) {
    const n = path.normalize(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
}
/** 两个路径是否指向同一位置（Windows 下忽略大小写）。 */
function samePath(a, b) {
    if (!a || !b)
        return a === b;
    return pathKey(a) === pathKey(b);
}
//# sourceMappingURL=pathutil.js.map