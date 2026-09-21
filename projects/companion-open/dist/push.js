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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PushManager = void 0;
/**
 * Web Push (VAPID) manager — dual storage for VS Code globalState + disk.
 * Host-free tests: `new PushManager({ storageDir })`.
 */
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const web_push_1 = __importDefault(require("web-push"));
const VAPID_STATE_KEY = 'copilotSidecar.vapidKeys';
const SUBS_STATE_KEY = 'copilotSidecar.pushSubscriptions';
const MAX_SUBS = 3;
const VAPID_SUBJECT = 'mailto:support@copilot-sidecar-companion.local';
function defaultStorageDir() {
    return path.join(os.homedir(), '.copilot-sidecar-companion');
}
function isMemento(x) {
    return (!!x &&
        typeof x === 'object' &&
        typeof x.get === 'function' &&
        typeof x.update === 'function');
}
function ensureDir(dir) {
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
}
function readJsonFile(file, fallback) {
    try {
        if (!fs.existsSync(file))
            return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
function writeJsonFile(file, value) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
        fs.chmodSync(file, 0o600);
    }
    catch { /* ignore */ }
}
function validSub(s) {
    return !!(s &&
        typeof s.endpoint === 'string' &&
        s.endpoint &&
        s.keys &&
        typeof s.keys.p256dh === 'string' &&
        typeof s.keys.auth === 'string');
}
class PushManager {
    publicKey;
    privateKey;
    subs = [];
    globalState;
    storageDir;
    vapidPath;
    subsPath;
    stateWriteChain = Promise.resolve();
    constructor(init) {
        if (isMemento(init)) {
            this.globalState = init;
            this.storageDir = defaultStorageDir();
        }
        else {
            this.globalState = init?.globalState;
            this.storageDir = init?.storageDir || defaultStorageDir();
        }
        this.vapidPath = path.join(this.storageDir, 'vapid.json');
        this.subsPath = path.join(this.storageDir, 'push-subscriptions.json');
        const keys = this.loadOrCreateVapid();
        this.publicKey = keys.publicKey;
        this.privateKey = keys.privateKey;
        web_push_1.default.setVapidDetails(VAPID_SUBJECT, this.publicKey, this.privateKey);
        this.subs = this.loadSubs();
    }
    get vapidPublicKey() {
        return this.publicKey;
    }
    get hasSubscribers() {
        return this.subs.length > 0;
    }
    get subscriberCount() {
        return this.subs.length;
    }
    addSubscription(sub) {
        const e = sub;
        if (!validSub(e))
            return;
        const next = {
            endpoint: e.endpoint,
            expirationTime: e.expirationTime ?? null,
            keys: { p256dh: e.keys.p256dh, auth: e.keys.auth },
        };
        this.subs = this.subs.filter((s) => s.endpoint !== next.endpoint);
        this.subs.push(next);
        while (this.subs.length > MAX_SUBS)
            this.subs.shift();
        this.persistSubs();
    }
    removeSubscription(endpoint) {
        const before = this.subs.length;
        this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
        if (this.subs.length !== before)
            this.persistSubs();
    }
    async notify(title, body, url = '/') {
        if (this.subs.length === 0)
            return;
        const payload = JSON.stringify({
            title: title || 'Copilot Sidecar',
            body: String(body || '').slice(0, 180),
            url: url || '/',
        });
        const stale = new Set();
        await Promise.allSettled(this.subs.map(async (sub) => {
            try {
                await web_push_1.default.sendNotification(sub, payload, { TTL: 3600 });
            }
            catch (err) {
                const code = err?.statusCode;
                if (code === 404 || code === 410)
                    stale.add(sub.endpoint);
            }
        }));
        if (stale.size > 0) {
            this.subs = this.subs.filter((s) => !stale.has(s.endpoint));
            this.persistSubs();
        }
    }
    loadOrCreateVapid() {
        const fromState = this.globalState?.get(VAPID_STATE_KEY);
        if (fromState?.publicKey && fromState?.privateKey) {
            try {
                writeJsonFile(this.vapidPath, fromState);
            }
            catch {
                /* ignore */
            }
            return fromState;
        }
        // also accept legacy key name if present in memento
        const legacy = this.globalState?.get('copilotSidecar.vapidKeys');
        if (legacy?.publicKey && legacy?.privateKey) {
            try {
                writeJsonFile(this.vapidPath, legacy);
            }
            catch {
                /* ignore */
            }
            return legacy;
        }
        const fromDisk = readJsonFile(this.vapidPath, null);
        if (fromDisk?.publicKey && fromDisk?.privateKey) {
            this.queueStateUpdate(VAPID_STATE_KEY, fromDisk);
            return fromDisk;
        }
        const generated = web_push_1.default.generateVAPIDKeys();
        const keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
        this.queueStateUpdate(VAPID_STATE_KEY, keys);
        try {
            writeJsonFile(this.vapidPath, keys);
        }
        catch {
            /* ignore */
        }
        return keys;
    }
    loadSubs() {
        const fromState = this.globalState?.get(SUBS_STATE_KEY);
        if (Array.isArray(fromState) && fromState.length) {
            const cleaned = fromState.filter(validSub).slice(-MAX_SUBS);
            try {
                writeJsonFile(this.subsPath, cleaned);
            }
            catch {
                /* ignore */
            }
            return cleaned;
        }
        // legacy key used by earlier stub
        const legacy = this.globalState?.get('copilotSidecar.pushSubs');
        if (Array.isArray(legacy) && legacy.length) {
            const cleaned = legacy.filter(validSub).slice(-MAX_SUBS);
            this.subs = cleaned;
            this.persistSubs();
            return cleaned;
        }
        const fromDisk = readJsonFile(this.subsPath, []);
        const cleaned = (Array.isArray(fromDisk) ? fromDisk : []).filter(validSub).slice(-MAX_SUBS);
        if (cleaned.length)
            this.queueStateUpdate(SUBS_STATE_KEY, cleaned);
        return cleaned;
    }
    persistSubs() {
        this.queueStateUpdate(SUBS_STATE_KEY, this.subs);
        // also mirror legacy key for older readers
        this.queueStateUpdate('copilotSidecar.pushSubs', this.subs);
        try {
            writeJsonFile(this.subsPath, this.subs);
        }
        catch {
            /* ignore */
        }
    }
    queueStateUpdate(key, value) {
        if (!this.globalState)
            return;
        this.stateWriteChain = this.stateWriteChain
            .then(() => Promise.resolve(this.globalState.update(key, value)))
            .catch(() => undefined);
    }
}
exports.PushManager = PushManager;
//# sourceMappingURL=push.js.map