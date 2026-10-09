export type ConnectionState =
  | "starting"
  | "pairing"
  | "connecting"
  | "open"
  | "closed"
  | "logged_out"
  | "conflict";

export interface PairingInfo {
  code?: string;
  qr?: string; // raw QR string; ingress renders it
}

export interface ClientStatus {
  state: ConnectionState;
  connected: boolean; // state === "open"
  me?: { jid: string; name?: string };
  pairing?: PairingInfo; // set only while state === "pairing"
  lastError?: string;
  since: string; // ISO timestamp of last state change
}

export interface GroupInfo {
  jid: string;
  name: string;
  participants: number;
  isMember: boolean;
}

export type OutboundContent =
  | { kind: "text"; text: string }
  | { kind: "image"; data: Buffer; mimetype: string; caption?: string }
  | { kind: "document"; data: Buffer; mimetype: string; filename: string; caption?: string };

export interface WhatsAppClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ClientStatus;
  /** From cache; never hits the network. */
  groups(): GroupInfo[];
  /** Network fetch, rate limited by cooldown. */
  refreshGroups(): Promise<GroupInfo[]>;
  send(jid: string, content: OutboundContent): Promise<{ id: string }>;
  on(event: "status", listener: (s: ClientStatus) => void): void;
}

/** Thrown by send() when the client is not in the `open` state. */
export class NotConnectedError extends Error {
  constructor(message = "WhatsApp is not connected") {
    super(message);
    this.name = "NotConnectedError";
  }
}

/** Thrown by send() when WhatsApp rejects or fails the send. */
export class SendError extends Error {
  constructor(message = "Failed to send message", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SendError";
  }
}
