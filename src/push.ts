/**
 * Web Push (VAPID) manager — dual storage for VS Code globalState + disk.
 * Host-free tests: `new PushManager({ storageDir })`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import webpush from 'web-push';

const VAPID_STATE_KEY = 'copilotSidecar.vapidKeys';
const SUBS_STATE_KEY = 'copilotSidecar.pushSubscriptions';
const MAX_SUBS = 3;
const VAPID_SUBJECT = 'mailto:support@copilot-sidecar-companion.local';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Minimal PushSubscription JSON shape (browser PushSubscription.toJSON()). */
export interface PushSubJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** VS Code Memento-like surface (globalState). */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | void;
}

/** @deprecated alias kept for older bridge/extension imports */
export type StateMemento = MementoLike;
/** @deprecated alias */
export type PushSubscriptionLike = PushSubJson;
/** @deprecated alias */
export type VapidKeyPair = VapidKeys;

export type PushManagerInit =
  | MementoLike
  | {
      storageDir?: string;
      globalState?: MementoLike;
    };

function defaultStorageDir(): string {
  return path.join(os.homedir(), '.copilot-sidecar-companion');
}

function isMemento(x: unknown): x is MementoLike {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as MementoLike).get === 'function' &&
    typeof (x as MementoLike).update === 'function'
  );
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: string, value: unknown) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

function validSub(s: any): s is PushSubJson {
  return !!(
    s &&
    typeof s.endpoint === 'string' &&
    s.endpoint &&
    s.keys &&
    typeof s.keys.p256dh === 'string' &&
    typeof s.keys.auth === 'string'
  );
}

export class PushManager {
  private publicKey: string;
  private privateKey: string;
  private subs: PushSubJson[] = [];
  private readonly globalState?: MementoLike;
  private readonly storageDir: string;
  private readonly vapidPath: string;
  private readonly subsPath: string;
  private stateWriteChain: Promise<void> = Promise.resolve();

  constructor(init?: PushManagerInit) {
    if (isMemento(init)) {
      this.globalState = init;
      this.storageDir = defaultStorageDir();
    } else {
      this.globalState = init?.globalState;
      this.storageDir = init?.storageDir || defaultStorageDir();
    }
    this.vapidPath = path.join(this.storageDir, 'vapid.json');
    this.subsPath = path.join(this.storageDir, 'push-subscriptions.json');

    const keys = this.loadOrCreateVapid();
    this.publicKey = keys.publicKey;
    this.privateKey = keys.privateKey;
    webpush.setVapidDetails(VAPID_SUBJECT, this.publicKey, this.privateKey);
    this.subs = this.loadSubs();
  }

  get vapidPublicKey(): string {
    return this.publicKey;
  }

  get hasSubscribers(): boolean {
    return this.subs.length > 0;
  }

  get subscriberCount(): number {
    return this.subs.length;
  }

  addSubscription(sub: PushSubJson | webpush.PushSubscription | Record<string, unknown> | undefined | null): void {
    const e = sub as any;
    if (!validSub(e)) return;
    const next: PushSubJson = {
      endpoint: e.endpoint,
      expirationTime: e.expirationTime ?? null,
      keys: { p256dh: e.keys.p256dh, auth: e.keys.auth },
    };
    this.subs = this.subs.filter((s) => s.endpoint !== next.endpoint);
    this.subs.push(next);
    while (this.subs.length > MAX_SUBS) this.subs.shift();
    this.persistSubs();
  }

  removeSubscription(endpoint: string): void {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.persistSubs();
  }

  async notify(title: string, body: string, url = '/'): Promise<void> {
    if (this.subs.length === 0) return;
    const payload = JSON.stringify({
      title: title || 'Copilot Sidecar',
      body: String(body || '').slice(0, 180),
      url: url || '/',
    });
    const stale = new Set<string>();
    await Promise.allSettled(
      this.subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub as webpush.PushSubscription, payload, { TTL: 3600 });
        } catch (err: any) {
          const code = err?.statusCode;
          if (code === 404 || code === 410) stale.add(sub.endpoint);
        }
      }),
    );
    if (stale.size > 0) {
      this.subs = this.subs.filter((s) => !stale.has(s.endpoint));
      this.persistSubs();
    }
  }

  private loadOrCreateVapid(): VapidKeys {
    const fromState = this.globalState?.get<VapidKeys>(VAPID_STATE_KEY);
    if (fromState?.publicKey && fromState?.privateKey) {
      try {
        writeJsonFile(this.vapidPath, fromState);
      } catch {
        /* ignore */
      }
      return fromState;
    }

    // also accept legacy key name if present in memento
    const legacy = this.globalState?.get<VapidKeys>('copilotSidecar.vapidKeys');
    if (legacy?.publicKey && legacy?.privateKey) {
      try {
        writeJsonFile(this.vapidPath, legacy);
      } catch {
        /* ignore */
      }
      return legacy;
    }

    const fromDisk = readJsonFile<VapidKeys | null>(this.vapidPath, null);
    if (fromDisk?.publicKey && fromDisk?.privateKey) {
      this.queueStateUpdate(VAPID_STATE_KEY, fromDisk);
      return fromDisk;
    }

    const generated = webpush.generateVAPIDKeys();
    const keys: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    this.queueStateUpdate(VAPID_STATE_KEY, keys);
    try {
      writeJsonFile(this.vapidPath, keys);
    } catch {
      /* ignore */
    }
    return keys;
  }

  private loadSubs(): PushSubJson[] {
    const fromState = this.globalState?.get<PushSubJson[]>(SUBS_STATE_KEY);
    if (Array.isArray(fromState) && fromState.length) {
      const cleaned = fromState.filter(validSub).slice(-MAX_SUBS);
      try {
        writeJsonFile(this.subsPath, cleaned);
      } catch {
        /* ignore */
      }
      return cleaned;
    }
    // legacy key used by earlier stub
    const legacy = this.globalState?.get<PushSubJson[]>('copilotSidecar.pushSubs');
    if (Array.isArray(legacy) && legacy.length) {
      const cleaned = legacy.filter(validSub).slice(-MAX_SUBS);
      this.subs = cleaned;
      this.persistSubs();
      return cleaned;
    }
    const fromDisk = readJsonFile<PushSubJson[]>(this.subsPath, []);
    const cleaned = (Array.isArray(fromDisk) ? fromDisk : []).filter(validSub).slice(-MAX_SUBS);
    if (cleaned.length) this.queueStateUpdate(SUBS_STATE_KEY, cleaned);
    return cleaned;
  }

  private persistSubs(): void {
    this.queueStateUpdate(SUBS_STATE_KEY, this.subs);
    // also mirror legacy key for older readers
    this.queueStateUpdate('copilotSidecar.pushSubs', this.subs);
    try {
      writeJsonFile(this.subsPath, this.subs);
    } catch {
      /* ignore */
    }
  }

  private queueStateUpdate(key: string, value: unknown): void {
    if (!this.globalState) return;
    this.stateWriteChain = this.stateWriteChain
      .then(() => Promise.resolve(this.globalState!.update(key, value)))
      .catch(() => undefined);
  }
}
