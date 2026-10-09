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

export interface SentMessage {
  jid: string;
  content: OutboundContent;
  id: string;
}

type StatusListener = (s: ClientStatus) => void;

/** In-memory WhatsAppClient for tests and GATEWAY_FAKE=1 local runs. */
export class FakeWhatsAppClient implements WhatsAppClient {
  readonly sent: SentMessage[] = [];
  refreshCount = 0;

  private current: ClientStatus;
  private groupList: GroupInfo[] = [];
  private refreshedGroups: GroupInfo[] | undefined;
  private failNext: Error | undefined;
  private counter = 0;
  private readonly listeners: StatusListener[] = [];
  private readonly now: () => Date;

  constructor(opts: { state?: ConnectionState; now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
    const state = opts.state ?? "starting";
    this.current = { state, connected: state === "open", since: this.now().toISOString() };
  }

  async start(): Promise<void> {
    if (this.current.state === "starting") this.setState("open");
  }

  async stop(): Promise<void> {
    this.setState("closed");
  }

  status(): ClientStatus {
    return { ...this.current };
  }

  groups(): GroupInfo[] {
    return this.groupList.map((g) => ({ ...g }));
  }

  async refreshGroups(): Promise<GroupInfo[]> {
    this.refreshCount += 1;
    if (this.refreshedGroups) this.groupList = this.refreshedGroups;
    return this.groups();
  }

  async send(jid: string, content: OutboundContent): Promise<{ id: string }> {
    if (!this.current.connected) throw new NotConnectedError();
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    this.counter += 1;
    const id = `FAKE${String(this.counter).padStart(8, "0")}`;
    this.sent.push({ jid, content, id });
    return { id };
  }

  on(event: "status", listener: StatusListener): void {
    if (event === "status") this.listeners.push(listener);
  }

  // Test helpers

  setState(
    state: ConnectionState,
    extra: { me?: ClientStatus["me"]; pairing?: PairingInfo; lastError?: string } = {},
  ): void {
    const next: ClientStatus = {
      state,
      connected: state === "open",
      since: this.now().toISOString(),
    };
    if (extra.me) next.me = extra.me;
    else if (this.current.me) next.me = this.current.me;
    if (state === "pairing" && extra.pairing) next.pairing = extra.pairing;
    if (extra.lastError) next.lastError = extra.lastError;
    this.current = next;
    for (const l of this.listeners) l(this.status());
  }

  setGroups(groups: GroupInfo[]): void {
    this.groupList = groups.map((g) => ({ ...g }));
  }

  /** Groups that the next refreshGroups() call will make visible. */
  setRefreshResult(groups: GroupInfo[]): void {
    this.refreshedGroups = groups.map((g) => ({ ...g }));
  }

  failNextSend(error: Error = new SendError()): void {
    this.failNext = error;
  }
}
