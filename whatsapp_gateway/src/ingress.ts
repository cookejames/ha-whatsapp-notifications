import http from "node:http";
import QRCode from "qrcode";
import type { Logger } from "pino";
import type { ClientStatus, GroupInfo, WhatsAppClient } from "./client.js";

/** Structural type; the real filter lives in ipfilter.ts. */
export type IngressIpFilter = { isAllowed(remoteAddress: string | undefined): boolean };

export interface IngressDeps {
  client: WhatsAppClient;
  resetAuth: () => Promise<void>;
  ipFilter: IngressIpFilter;
  logger: Pick<Logger, "info" | "warn" | "error">;
  apiKeyConfigured: boolean;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1c1c1c;--muted:#666;--card:#fff;--border:#d8d8d8;--accent:#0b6bcb;--warn-bg:#fff4d6;--warn-fg:#6b4a00;--danger:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eaeaea;--muted:#a0a0a0;--card:#222;--border:#3a3a3a;--accent:#5aa9ff;--warn-bg:#3a2e0a;--warn-fg:#ffd77a;--danger:#ef6b6b}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto}
section{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px}
h1{font-size:1.3rem;margin:0 0 12px}h2{font-size:1.05rem;margin:0 0 8px}
.badge{display:inline-block;padding:2px 10px;border-radius:12px;border:1px solid var(--border);font-weight:600}
.muted{color:var(--muted)}
.warn{background:var(--warn-bg);color:var(--warn-fg);border-color:var(--warn-fg)}
.code{font:700 2rem ui-monospace,monospace;letter-spacing:.1em}
.qr svg{width:260px;height:260px;max-width:100%;background:#fff;padding:8px;border-radius:4px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--border);vertical-align:top}
td.jid{font-family:ui-monospace,monospace;font-size:.85rem;word-break:break-all}
button{font:inherit;padding:4px 12px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
button.danger{border-color:var(--danger);color:var(--danger)}
form{display:inline}
`;

const SCRIPT = `
document.querySelectorAll('button[data-jid]').forEach(function(b){
  b.addEventListener('click',function(){
    var jid=b.getAttribute('data-jid');
    var done=function(){var t=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=t},1500)};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(jid).then(done,function(){})}
  });
});
`;

function sortedMemberGroups(groups: GroupInfo[]): GroupInfo[] {
  return groups
    .filter((g) => g.isMember)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

async function pairingSection(status: ClientStatus): Promise<string> {
  if (status.state !== "pairing") return "";
  const p = status.pairing;
  if (p?.code) {
    return `<section><h2>Pair WhatsApp</h2>
<div class="code">${escapeHtml(p.code)}</div>
<p>On your phone: WhatsApp &rarr; Settings &rarr; Linked devices &rarr; Link a device &rarr; Link with phone number instead, then enter this code.</p></section>`;
  }
  if (p?.qr) {
    const svg = await QRCode.toString(p.qr, { type: "svg", margin: 1 });
    return `<section><h2>Pair WhatsApp</h2>
<div class="qr">${svg}</div>
<p>On your phone: WhatsApp &rarr; Settings &rarr; Linked devices &rarr; Link a device, then scan this QR code.</p></section>`;
  }
  return `<section><h2>Pair WhatsApp</h2><p class="muted">Waiting for a pairing code or QR code...</p></section>`;
}

function resetForm(label: string): string {
  return `<form method="post" action="reset-pairing" onsubmit="return confirm('Remove the linked WhatsApp session and pair again?')"><button type="submit" class="danger">${escapeHtml(label)}</button></form>`;
}

function groupsSection(groups: GroupInfo[]): string {
  const rows = sortedMemberGroups(groups)
    .map(
      (g) =>
        `<tr><td>${escapeHtml(g.name)}</td><td>${String(Number(g.participants) || 0)}</td><td class="jid">${escapeHtml(g.jid)}</td><td><button type="button" data-jid="${escapeHtml(g.jid)}">Copy JID</button></td></tr>`,
    )
    .join("\n");
  const table = rows
    ? `<table><thead><tr><th>Name</th><th>Members</th><th>JID</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted">No groups yet. Add the linked number to a group, then refresh.</p>`;
  return `<section><h2>Groups</h2>${table}
<p><form method="post" action="refresh-groups"><button type="submit">Refresh groups</button></form></p></section>`;
}

export async function renderPage(
  status: ClientStatus,
  groups: GroupInfo[],
  apiKeyConfigured: boolean,
): Promise<string> {
  const refresh = status.state === "pairing" || status.state === "connecting";
  const prominent = status.state === "logged_out" || status.state === "conflict";
  const parts: string[] = [];

  parts.push(`<section><h1>WhatsApp Gateway</h1>
<span class="badge">${escapeHtml(status.state)}</span>
<span class="muted">since ${escapeHtml(status.since)}</span>
${status.me ? `<p>Linked as ${escapeHtml(status.me.name ?? status.me.jid)}</p>` : ""}
${status.lastError ? `<p class="muted">Last error: ${escapeHtml(status.lastError)}</p>` : ""}</section>`);

  if (!apiKeyConfigured) {
    parts.push(
      `<section class="warn"><strong>API key missing or too short.</strong> Set a strong <code>api_key</code> in the add-on configuration.</section>`,
    );
  }

  if (status.state === "logged_out") {
    parts.push(
      `<section><h2>Logged out</h2><p>This device was unlinked from WhatsApp. Reset pairing to link it again.</p>${resetForm("Reset pairing")}</section>`,
    );
  } else if (status.state === "conflict") {
    parts.push(
      `<section><h2>Session conflict</h2><p>WhatsApp was opened for this linked device somewhere else. If this persists, reset pairing and link again.</p>${resetForm("Reset pairing")}</section>`,
    );
  }

  parts.push(await pairingSection(status));
  parts.push(groupsSection(groups));

  if (!prominent) {
    parts.push(
      `<section><details><summary>Advanced</summary><p class="muted">Removes the linked session so you can pair again.</p>${resetForm("Reset pairing")}</details></section>`,
    );
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="5">' : ""}
<title>WhatsApp Gateway</title><style>${STYLE}</style></head>
<body><main>
${parts.join("\n")}
</main><script>${SCRIPT}</script></body></html>`;
}

export function createIngressServer(deps: IngressDeps): http.Server {
  const { client, resetAuth, ipFilter, logger, apiKeyConfigured } = deps;

  function notAllowed(res: http.ServerResponse): void {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!ipFilter.isAllowed(req.socket.remoteAddress)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    if (path === "/") {
      if (method !== "GET" && method !== "HEAD") return notAllowed(res);
      const html = await renderPage(client.status(), client.groups(), apiKeyConfigured);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(method === "HEAD" ? undefined : html);
      return;
    }
    if (path === "/refresh-groups" || path === "/reset-pairing") {
      if (method !== "POST") return notAllowed(res);
      req.resume();
      try {
        if (path === "/refresh-groups") await client.refreshGroups();
        else await resetAuth();
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), route: path },
          "Ingress action failed",
        );
      }
      res.writeHead(303, { location: "./" });
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Ingress request failed",
      );
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal error");
    });
  });
}
