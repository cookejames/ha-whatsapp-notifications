import { rm } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  useMultiFileAuthState,
  type AnyMessageContent,
  type AuthenticationState,
  type BaileysEventMap,
  type GroupMetadata,
  type WAVersion,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import {
  NotConnectedError,
  SendError,
  type ClientStatus,
  type ConnectionState,
  type GroupInfo,
  type OutboundContent,
  type PairingInfo,
  type WhatsAppClient,
} from "./client.js";
import { GroupCache, stripDevice } from "./groups.js";
import { maskJid } from "./logger.js";

/**
 * WhatsApp rejects stale client versions with HTTP 428, so we normally ask
 * Baileys for the current WA Web version. This is only used when that lookup
 * fails (offline, GitHub unreachable). It is the version bundled with the pinned
 * Baileys release and must be revisited whenever the Baileys pin is bumped.
 */
export const FALLBACK_WA_VERSION: WAVersion = [2, 3000, 1043857760];

export const VERSION_CACHE_MS = 6 * 60 * 60 * 1000;
export const PAIRING_DELAY_MS = 3_000;
export const PAIRING_TIMEOUT_MS = 20_000;
export const CONFLICT_RETRY_MS = 30_000;
const STATUS_CONNECTION_CLOSED = DisconnectReason.connectionClosed; // 428
const STATUS_LOGGED_OUT = DisconnectReason.loggedOut; // 401
const STATUS_REPLACED = DisconnectReason.connectionReplaced; // 440

/** The subset of a Baileys socket this client relies on. Tests provide a fake. */
export interface SocketLike {
  ev: {
    on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void;
    removeAllListeners<T extends keyof BaileysEventMap>(event: T): void;
  };
  authState: { creds: { registered?: boolean } };
  user?: { id: string; lid?: string; name?: string } | undefined;
  requestPairingCode(phoneNumber: string): Promise<string>;
  sendMessage(jid: string, content: AnyMessageContent): Promise<{ key?: { id?: string | null } } | undefined>;
  groupFetchAllParticipating(): Promise<Record<string, GroupMetadata>>;
  end(error: Error | undefined): void | Promise<void>;
}

/** Everything a socket factory needs to build a socket. */
export interface SocketParams {
  version: WAVersion;
  auth: AuthenticationState;
  logger: Logger;
  cachedGroupMetadata: (jid: string) => Promise<GroupMetadata | undefined>;
}

export type SocketFactory = (params: SocketParams) => SocketLike;

/**
 * History-sync types Baileys may process. These small early syncs carry the
 * phone-number/LID mappings and contact names Baileys needs for stable
 * sessions. Refusing every type makes Baileys warn about instability. Bulk
 * message history (FULL, RECENT, ON_DEMAND) and status sync stay off. Nothing
 * from any sync is stored: this gateway subscribes to no message or history
 * events.
 */
export const SYNCED_HISTORY_TYPES: ReadonlySet<proto.Message.HistorySyncType> = new Set([
  proto.Message.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.Message.HistorySyncType.PUSH_NAME,
  proto.Message.HistorySyncType.NON_BLOCKING_DATA,
]);

/** Exact socket options from spec §3.5. */
export function buildSocketConfig(params: SocketParams): Parameters<typeof makeWASocket>[0] {
  return {
    version: params.version,
    auth: params.auth,
    browser: Browsers.macOS("Chrome"),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: ({ syncType }) =>
      syncType != null && SYNCED_HISTORY_TYPES.has(syncType),
    defaultQueryTimeoutMs: 60_000,
    generateHighQualityLinkPreview: false,
    logger: params.logger,
    cachedGroupMetadata: params.cachedGroupMetadata,
  };
}

export const defaultSocketFactory: SocketFactory = (params) =>
  makeWASocket(buildSocketConfig(params)) as unknown as SocketLike;

export interface BaileysClientOptions {
  dataDir: string;
  pairingPhoneNumber?: string | undefined;
  /** Application logger. */
  logger: Logger;
  socketFactory?: SocketFactory;
  /** Test seams. */
  deps?: {
    loadAuth?: (dir: string) => Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
    fetchVersion?: () => Promise<{ version: WAVersion; error?: unknown }>;
    now?: () => number;
    random?: () => number;
    groups?: GroupCache;
  };
}

type StatusListener = (s: ClientStatus) => void;

interface Session {
  gen: number;
  sock: SocketLike;
  /** Resolves when this socket reports `close`. */
  closed: Promise<"closed">;
  markClosed: () => void;
}

function statusCodeOf(err: unknown): number | undefined {
  const code = (err as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  return typeof code === "number" ? code : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class BaileysClient implements WhatsAppClient {
  private readonly dataDir: string;
  private readonly pairingPhone: string | undefined;
  private readonly logger: Logger;
  private readonly socketFactory: SocketFactory;
  private readonly loadAuth: NonNullable<NonNullable<BaileysClientOptions["deps"]>["loadAuth"]>;
  private readonly fetchVersion: NonNullable<NonNullable<BaileysClientOptions["deps"]>["fetchVersion"]>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly cache: GroupCache;
  private readonly listeners: StatusListener[] = [];

  private current: ClientStatus;
  private generation = 0;
  private session: Session | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pairingTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private conflictRetried = false;
  private running = false;
  private cachedVersion: { version: WAVersion; at: number } | undefined;

  constructor(opts: BaileysClientOptions) {
    this.dataDir = opts.dataDir;
    this.pairingPhone = opts.pairingPhoneNumber?.replace(/\D/g, "") || undefined;
    this.logger = opts.logger;
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
    this.loadAuth = opts.deps?.loadAuth ?? ((dir) => useMultiFileAuthState(dir));
    this.fetchVersion = opts.deps?.fetchVersion ?? (() => fetchLatestBaileysVersion());
    this.now = opts.deps?.now ?? (() => Date.now());
    this.random = opts.deps?.random ?? Math.random;
    this.cache =
      opts.deps?.groups ??
      new GroupCache({ file: join(opts.dataDir, "groups.json"), logger: opts.logger, now: this.now });
    this.current = { state: "starting", connected: false, since: new Date(this.now()).toISOString() };
  }

  // WhatsAppClient

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.cache.load();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.teardown();
    this.setState("closed");
  }

  status(): ClientStatus {
    const s: ClientStatus = { ...this.current };
    if (s.me) s.me = { ...s.me };
    if (s.pairing) s.pairing = { ...s.pairing };
    return s;
  }

  groups(): GroupInfo[] {
    return this.cache.list();
  }

  refreshGroups(): Promise<GroupInfo[]> {
    return this.cache.refresh();
  }

  async send(jid: string, content: OutboundContent): Promise<{ id: string }> {
    const session = this.session;
    if (this.current.state !== "open" || !session) throw new NotConnectedError();
    let message: AnyMessageContent;
    switch (content.kind) {
      case "text":
        message = { text: content.text };
        break;
      case "image":
        message = {
          image: content.data,
          mimetype: content.mimetype,
          ...(content.caption !== undefined ? { caption: content.caption } : {}),
        };
        break;
      case "document":
        message = {
          document: content.data,
          mimetype: content.mimetype,
          fileName: content.filename,
          ...(content.caption !== undefined ? { caption: content.caption } : {}),
        };
        break;
    }
    let sent;
    try {
      sent = await session.sock.sendMessage(jid, message);
    } catch (err) {
      // Do not include message content in logs.
      this.logger.warn({ to: maskJid(jid), kind: content.kind, err: messageOf(err) }, "Send failed");
      throw new SendError(`Failed to send message: ${messageOf(err)}`, { cause: err });
    }
    const id = sent?.key?.id;
    if (!id) throw new SendError("WhatsApp did not return a message id");
    this.logger.info({ to: maskJid(jid), kind: content.kind, id }, "Message sent");
    return { id };
  }

  on(event: "status", listener: StatusListener): void {
    if (event === "status") this.listeners.push(listener);
  }

  /** Stop, delete `<dataDir>/auth`, and restart so a new pairing can happen. */
  async resetAuth(): Promise<void> {
    this.teardown();
    await rm(join(this.dataDir, "auth"), { recursive: true, force: true });
    this.logger.info("Auth state removed; restarting for a new pairing");
    this.attempt = 0;
    this.conflictRetried = false;
    this.running = true;
    await this.connect();
  }

  // Internals

  private setState(
    state: ConnectionState,
    extra: { pairing?: PairingInfo; lastError?: string; me?: ClientStatus["me"] } = {},
  ): void {
    const next: ClientStatus = { state, connected: state === "open", since: new Date(this.now()).toISOString() };
    const me = extra.me ?? (state === "open" || state === "connecting" ? this.current.me : undefined);
    if (me) next.me = me;
    if (state === "pairing" && extra.pairing) next.pairing = extra.pairing;
    const lastError = extra.lastError ?? (state === "open" ? undefined : this.current.lastError);
    if (lastError) next.lastError = lastError;
    this.current = next;
    for (const l of this.listeners) {
      try {
        l(this.status());
      } catch (err) {
        this.logger.warn({ err: messageOf(err) }, "Status listener threw");
      }
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.reconnectTimer = undefined;
    this.pairingTimer = undefined;
  }

  /** Invalidate the current socket (all its events become stale) and end it. */
  private teardown(): void {
    this.generation += 1;
    this.clearTimers();
    this.cache.detach();
    const s = this.session;
    this.session = undefined;
    if (!s) return;
    s.markClosed();
    this.disposeSocket(s.sock);
  }

  private disposeSocket(sock: SocketLike): void {
    for (const ev of [
      "connection.update",
      "creds.update",
      "groups.upsert",
      "groups.update",
      "group-participants.update",
    ] as const) {
      try {
        sock.ev.removeAllListeners(ev);
      } catch {
        // ignore
      }
    }
    try {
      void Promise.resolve(sock.end(undefined)).catch(() => undefined);
    } catch {
      // already closed
    }
  }

  private async getVersion(): Promise<WAVersion> {
    const cached = this.cachedVersion;
    if (cached && this.now() - cached.at < VERSION_CACHE_MS) return cached.version;
    try {
      const res = await this.fetchVersion();
      if (!res.error) {
        this.cachedVersion = { version: res.version, at: this.now() };
        return res.version;
      }
      this.logger.warn({ err: messageOf(res.error) }, "WA version lookup failed; using fallback");
    } catch (err) {
      this.logger.warn({ err: messageOf(err) }, "WA version lookup failed; using fallback");
    }
    return FALLBACK_WA_VERSION;
  }

  private async connect(): Promise<void> {
    this.teardown();
    const gen = this.generation;
    this.setState("connecting");
    let sock: SocketLike;
    let saveCreds: () => Promise<void>;
    try {
      const { state, saveCreds: save } = await this.loadAuth(join(this.dataDir, "auth"));
      saveCreds = save;
      const version = await this.getVersion();
      if (gen !== this.generation) return;
      sock = this.socketFactory({
        version,
        auth: state,
        logger: this.logger.child({ module: "baileys" }, { level: this.baileysLogLevel() }),
        cachedGroupMetadata: async (jid) => this.cache.metadata(jid),
      });
    } catch (err) {
      if (gen !== this.generation) return;
      this.logger.error({ err: messageOf(err) }, "Failed to create WhatsApp socket");
      this.setState("closed", { lastError: messageOf(err) });
      this.scheduleReconnect(this.backoffDelay());
      return;
    }
    if (gen !== this.generation) {
      this.disposeSocket(sock);
      return;
    }

    let markClosed!: () => void;
    const closed = new Promise<"closed">((resolve) => {
      markClosed = () => resolve("closed");
    });
    const session: Session = { gen, sock, closed, markClosed };
    this.session = session;
    this.bind(session, saveCreds);
    this.maybeRequestPairingCode(session);
  }

  private baileysLogLevel(): string {
    return this.logger.level === "debug" ? "debug" : "warn";
  }

  private bind(session: Session, saveCreds: () => Promise<void>): void {
    const { gen, sock } = session;
    const live = () => gen === this.generation;

    sock.ev.on("creds.update", () => {
      if (!live()) return;
      saveCreds().catch((err: unknown) => {
        this.logger.error({ err: messageOf(err) }, "Failed to save credentials");
      });
    });

    sock.ev.on("connection.update", (u) => {
      if (!live()) return;
      if (u.qr && !this.pairingPhone) {
        this.setState("pairing", { pairing: { qr: u.qr } });
      }
      if (u.connection === "open") this.onOpen(session);
      else if (u.connection === "close") this.onClose(session, u.lastDisconnect?.error);
    });

    sock.ev.on("groups.upsert", (g) => {
      if (!live()) return;
      this.cache.applyUpdate(g);
      this.cache.scheduleRefresh();
    });
    sock.ev.on("groups.update", (g) => {
      if (!live()) return;
      this.cache.applyUpdate(g);
      this.cache.scheduleRefresh();
    });
    sock.ev.on("group-participants.update", (e) => {
      if (!live()) return;
      this.cache.applyParticipants(e, this.selfIds(sock));
      this.cache.scheduleRefresh();
    });
    // messages.upsert (and every other message event) is deliberately not subscribed.
  }

  private selfIds(sock: SocketLike): string[] {
    return [sock.user?.id, sock.user?.lid].filter((v): v is string => typeof v === "string");
  }

  private onOpen(session: Session): void {
    this.attempt = 0;
    this.conflictRetried = false;
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = undefined;
    const user = session.sock.user;
    const me = user ? { jid: stripDevice(user.id), ...(user.name ? { name: user.name } : {}) } : undefined;
    this.setState("open", me ? { me } : {});
    this.logger.info({ me: me ? maskJid(me.jid) : undefined }, "WhatsApp connection open");
    this.cache.attach(() => session.sock.groupFetchAllParticipating());
    void this.cache.refresh();
  }

  private onClose(session: Session, error: unknown): void {
    const code = statusCodeOf(error);
    const registered = session.sock.authState.creds.registered === true;
    // Invalidate this socket: any further events from it are stale.
    this.generation += 1;
    this.session = undefined;
    this.clearTimers();
    this.cache.detach();
    session.markClosed();
    this.disposeSocket(session.sock);
    const lastError = error ? messageOf(error) : undefined;
    this.logger.info({ code }, "WhatsApp connection closed");

    if (code === STATUS_LOGGED_OUT) {
      this.setState("logged_out", lastError ? { lastError } : {});
      return;
    }
    if (code === STATUS_REPLACED) {
      this.setState("conflict", lastError ? { lastError } : {});
      if (this.conflictRetried) return;
      this.conflictRetried = true;
      this.scheduleReconnect(CONFLICT_RETRY_MS);
      return;
    }
    this.setState("closed", lastError ? { lastError } : {});
    if (code === STATUS_CONNECTION_CLOSED && !registered) {
      this.attempt += 1;
      this.scheduleReconnect(Math.min(2000 * this.attempt, 15_000));
      return;
    }
    this.scheduleReconnect(this.backoffDelay());
  }

  /** min(1000 * 2^attempt, 60000) with +-20% jitter; counts the attempt. */
  private backoffDelay(): number {
    const base = Math.min(1000 * 2 ** this.attempt, 60_000);
    this.attempt += 1;
    return Math.round(base * (0.8 + 0.4 * this.random()));
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.running) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.logger.info({ delayMs }, "Scheduling WhatsApp reconnect");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.running) return;
      void this.connect();
    }, delayMs);
  }

  private maybeRequestPairingCode(session: Session): void {
    const phone = this.pairingPhone;
    if (!phone || session.sock.authState.creds.registered) return;
    this.pairingTimer = setTimeout(() => {
      this.pairingTimer = undefined;
      if (session.gen !== this.generation) return;
      void this.requestPairingCode(session, phone);
    }, PAIRING_DELAY_MS);
  }

  private async requestPairingCode(session: Session, phone: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), PAIRING_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        session.sock.requestPairingCode(phone),
        timeout,
        session.closed,
      ]);
      if (session.gen !== this.generation) return;
      if (result === "closed") return; // the close handler owns the reconnect
      if (result === "timeout") throw new Error("Pairing code request timed out");
      this.logger.info({ code: result }, "Pairing code ready: enter it in WhatsApp > Linked devices > Link with phone number");
      this.setState("pairing", { pairing: { code: result } });
    } catch (err) {
      if (session.gen !== this.generation) return;
      const lastError = messageOf(err);
      this.logger.warn({ err: lastError }, "Pairing code request failed");
      this.generation += 1;
      this.session = undefined;
      this.cache.detach();
      this.disposeSocket(session.sock);
      this.setState("closed", { lastError });
      this.attempt += 1;
      this.scheduleReconnect(Math.min(2000 * this.attempt, 15_000));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
