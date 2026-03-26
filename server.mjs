import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

// ─────────────────────────────────────────────
// KONFIGURÁCIA ÚČTOV Z ENVIRONMENT VARIABLES
// ─────────────────────────────────────────────
// Formát: IMAP_ACCOUNT_<MENO>_HOST, _PORT, _USER, _PASS, _SMTP_HOST, _SMTP_PORT, _SMTP_SECURE, _SENT_FOLDER
// Príklad:
//   IMAP_ACCOUNT_INFO_HOST=imap.example.com
//   IMAP_ACCOUNT_INFO_PORT=993
//   IMAP_ACCOUNT_INFO_USER=info@digitalberry.sk
//   IMAP_ACCOUNT_INFO_PASS=heslo123
//   IMAP_ACCOUNT_INFO_SMTP_HOST=smtp.example.com
//   IMAP_ACCOUNT_INFO_SMTP_PORT=465
//   IMAP_ACCOUNT_INFO_SMTP_SECURE=true
//   IMAP_ACCOUNT_INFO_SENT_FOLDER=Sent   (voliteľné, auto-detekcia)

function loadAccounts() {
  const accounts = {};
  const prefix = "IMAP_ACCOUNT_";
  const keys = Object.keys(process.env).filter((k) => k.startsWith(prefix));

  const names = new Set();
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    const name = rest.split("_")[0];
    names.add(name);
  }

  for (const name of names) {
    const p = `${prefix}${name}_`;
    const host = process.env[`${p}HOST`];
    const user = process.env[`${p}USER`];
    const pass = process.env[`${p}PASS`];

    if (!host || !user || !pass) {
      console.error(`[${name}] Chýba HOST, USER alebo PASS — účet preskočený.`);
      continue;
    }

    accounts[name.toLowerCase()] = {
      name: name.toLowerCase(),
      imap: {
        host,
        port: parseInt(process.env[`${p}PORT`] || "993", 10),
        user,
        pass,
        secure: (process.env[`${p}SECURE`] || "true") === "true",
      },
      smtp: {
        host: process.env[`${p}SMTP_HOST`] || host.replace("imap.", "smtp."),
        port: parseInt(process.env[`${p}SMTP_PORT`] || "465", 10),
        user: process.env[`${p}SMTP_USER`] || user,
        pass: process.env[`${p}SMTP_PASS`] || pass,
        secure: (process.env[`${p}SMTP_SECURE`] || "true") === "true",
      },
      sentFolder: process.env[`${p}SENT_FOLDER`] || null,
    };
  }

  return accounts;
}

const ACCOUNTS = loadAccounts();
console.error(`Načítaných ${Object.keys(ACCOUNTS).length} účtov: ${Object.keys(ACCOUNTS).join(", ") || "(žiadne)"}`);

// ─────────────────────────────────────────────
// FIX: Accept header patch pre claude.ai kompatibilitu
// ─────────────────────────────────────────────
const origHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
StreamableHTTPServerTransport.prototype.handleRequest = function(req, res, body) {
  req.headers["accept"] = "application/json, text/event-stream";
  return origHandleRequest.call(this, req, res, body);
};

// ─────────────────────────────────────────────
// IMAP + SMTP HELPERS
// ─────────────────────────────────────────────

async function getImapClient(accountName) {
  const acc = ACCOUNTS[accountName];
  if (!acc) throw new Error(`Účet "${accountName}" neexistuje. Použi list_accounts pre zoznam.`);

  const client = new ImapFlow({
    host: acc.imap.host,
    port: acc.imap.port,
    secure: acc.imap.secure,
    auth: { user: acc.imap.user, pass: acc.imap.pass },
    logger: false,
  });

  await client.connect();
  return client;
}

function getSmtpTransport(accountName) {
  const acc = ACCOUNTS[accountName];
  if (!acc) throw new Error(`Účet "${accountName}" neexistuje.`);

  return nodemailer.createTransport({
    host: acc.smtp.host,
    port: acc.smtp.port,
    secure: acc.smtp.secure,
    auth: { user: acc.smtp.user, pass: acc.smtp.pass },
  });
}

async function detectSentFolder(client, accountName) {
  const acc = ACCOUNTS[accountName];
  if (acc.sentFolder) return acc.sentFolder;

  const folders = await client.list();

  // Priorita 1: špeciálne označenie
  for (const folder of folders) {
    if (folder.specialUse === "\\Sent") return folder.path;
  }

  // Priorita 2: názov
  const candidates = ["Sent", "INBOX.Sent", "Sent Items", "Sent Mail", "Odoslané", "INBOX.Odoslané", "[Gmail]/Sent Mail"];
  for (const c of candidates) {
    for (const f of folders) {
      if (f.path.toLowerCase() === c.toLowerCase()) return f.path;
    }
  }

  return "Sent";
}

async function saveToSent(accountName, rawMessage) {
  const client = await getImapClient(accountName);
  try {
    const sentFolder = await detectSentFolder(client, accountName);
    await client.append(sentFolder, rawMessage, ["\\Seen"]);
    return sentFolder;
  } finally {
    await client.logout().catch(() => {});
  }
}

// Generovanie plnej MIME správy cez nodemailer (vrátane HTML, príloh, multipart)
async function buildRawMessage(options) {
  return new Promise((resolve, reject) => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const mailOptions = {
      from: options.from,
      to: options.to,
      subject: options.subject,
      text: options.text || undefined,
      html: options.html || undefined,
      cc: options.cc || undefined,
      bcc: options.bcc || undefined,
      replyTo: options.replyTo || undefined,
      messageId: options.messageId || undefined,
      inReplyTo: options.inReplyTo || undefined,
      references: options.references || undefined,
      date: new Date(),
    };
    if (options.attachments?.length) {
      mailOptions.attachments = options.attachments;
    }
    transport.sendMail(mailOptions, (err, info) => {
      if (err) return reject(err);
      // info.message obsahuje kompletný MIME string (JSON transport ho vráti ako JSON)
      // Potrebujeme skutočný raw MIME — použijeme buildMail
      resolve(null);
    });
  }).catch(() => null).then(async () => {
    // Lepší prístup: použijeme nodemailer MailComposer priamo
    const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");
    const mail = new MailComposer({
      from: options.from,
      to: options.to,
      subject: options.subject,
      text: options.text || undefined,
      html: options.html || undefined,
      cc: options.cc || undefined,
      bcc: options.bcc || undefined,
      replyTo: options.replyTo || undefined,
      messageId: options.messageId || undefined,
      inReplyTo: options.inReplyTo || undefined,
      references: options.references || undefined,
      date: new Date(),
      attachments: options.attachments || undefined,
    });
    return new Promise((resolve, reject) => {
      mail.compile().build((err, message) => {
        if (err) reject(err);
        else resolve(message);
      });
    });
  });
}

function formatEmail(msg, includeBody = false) {
  const lines = [
    `UID: ${msg.uid}`,
    `Od: ${msg.envelope?.from?.map((f) => `${f.name || ""} <${f.address}>`).join(", ") || "N/A"}`,
    `Komu: ${msg.envelope?.to?.map((t) => `${t.name || ""} <${t.address}>`).join(", ") || "N/A"}`,
    `Predmet: ${msg.envelope?.subject || "(bez predmetu)"}`,
    `Dátum: ${msg.envelope?.date ? new Date(msg.envelope.date).toLocaleString("sk-SK") : "N/A"}`,
    `Prečítané: ${msg.flags?.has("\\Seen") ? "Áno" : "Nie"}`,
    `Flagged: ${msg.flags?.has("\\Flagged") ? "Áno" : "Nie"}`,
  ];

  if (msg.envelope?.cc?.length) {
    lines.push(`CC: ${msg.envelope.cc.map((c) => `${c.name || ""} <${c.address}>`).join(", ")}`);
  }

  if (includeBody && msg.bodyText) {
    const body = msg.bodyText.length > 15000
      ? msg.bodyText.substring(0, 15000) + `\n\n... (skrátené, celkovo ${msg.bodyText.length} znakov)`
      : msg.bodyText;
    lines.push(`\n--- Obsah ---\n${body}`);
  }

  if (msg.attachments?.length) {
    lines.push(`Prílohy: ${msg.attachments.map((a) => `${a.filename || "bez_nazvu"} (${a.size ? (a.size / 1024).toFixed(1) + " KB" : "?"}, part: ${a.part || "?"})`).join(", ")}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// MCP SERVER FACTORY
// ─────────────────────────────────────────────

function createServer() {
  const server = new McpServer({ name: "imap-mcp-server", version: "1.0.0" });

  const accountParam = z.string().describe("Názov emailového účtu. Použi list_accounts pre zoznam.");

  // ── LIST ACCOUNTS ──
  server.tool("list_accounts", "Zobrazí zoznam nakonfigurovaných emailových účtov.", {}, async () => {
    const lines = Object.values(ACCOUNTS).map(
      (acc) => `• ${acc.name} — ${acc.imap.user} (IMAP: ${acc.imap.host}, SMTP: ${acc.smtp.host})`
    );
    return {
      content: [{ type: "text", text: lines.length > 0 ? `Účty (${lines.length}):\n${lines.join("\n")}` : "Žiadne účty nie sú nakonfigurované." }],
    };
  });

  // ── LIST FOLDERS ──
  server.tool("imap_list_folders", "Zobrazí priečinky emailového účtu.", { account: accountParam }, async ({ account }) => {
    const client = await getImapClient(account);
    try {
      const folders = await client.list();
      const lines = folders.map((f) => `• ${f.path}${f.specialUse ? ` [${f.specialUse}]` : ""}`);
      return { content: [{ type: "text", text: `[${account}] Priečinky (${lines.length}):\n${lines.join("\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally {
      await client.logout().catch(() => {});
    }
  });

  // ── FOLDER STATUS ──
  server.tool("imap_folder_status", "Stav priečinka — počet správ, neprečítané.", {
    account: accountParam,
    folder: z.string().default("INBOX").describe("Priečinok"),
  }, async ({ account, folder }) => {
    const client = await getImapClient(account);
    try {
      const status = await client.status(folder, { messages: true, unseen: true, recent: true });
      return { content: [{ type: "text", text: `[${account}] ${folder}: Celkom ${status.messages}, neprečítaných ${status.unseen}, nových ${status.recent}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally {
      await client.logout().catch(() => {});
    }
  });

  // ── UNREAD COUNT ──
  server.tool("imap_get_unread_count", "Počet neprečítaných emailov.", {
    account: accountParam,
    folders: z.array(z.string()).optional().describe("Priečinky (default: INBOX)"),
  }, async ({ account, folders }) => {
    const client = await getImapClient(account);
    try {
      const targets = folders?.length ? folders : ["INBOX"];
      const results = [];
      for (const f of targets) {
        try {
          const s = await client.status(f, { unseen: true });
          results.push(`${f}: ${s.unseen}`);
        } catch { results.push(`${f}: chyba`); }
      }
      return { content: [{ type: "text", text: `[${account}] Neprečítané:\n${results.join("\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally {
      await client.logout().catch(() => {});
    }
  });

  // ── GET LATEST EMAILS ──
  server.tool("imap_get_latest_emails", "Najnovšie emaily z priečinka.", {
    account: accountParam,
    folder: z.string().default("INBOX").describe("Priečinok"),
    count: z.number().default(10).describe("Počet (max 50)"),
  }, async ({ account, folder, count }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const total = client.mailbox.exists;
        if (total === 0) return { content: [{ type: "text", text: `[${account}] ${folder}: Prázdny.` }] };

        const limit = Math.min(count, 50, total);
        const from = Math.max(total - limit + 1, 1);
        const messages = [];
        for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, bodyStructure: true })) {
          messages.push(msg);
        }
        messages.sort((a, b) => new Date(b.envelope.date) - new Date(a.envelope.date));
        const lines = messages.map((msg, i) => `--- Email ${i + 1} ---\n${formatEmail(msg)}`);
        return { content: [{ type: "text", text: `[${account}] ${folder} — posledných ${messages.length}:\n\n${lines.join("\n\n")}` }] };
      } finally { lock.release(); }
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally {
      await client.logout().catch(() => {});
    }
  });

  // ── SEARCH EMAILS ──
  server.tool("imap_search_emails", "Vyhľadávanie emailov podľa kritérií.", {
    account: accountParam,
    folder: z.string().default("INBOX"),
    from: z.string().optional().describe("Odosielateľ"),
    to: z.string().optional().describe("Príjemca"),
    subject: z.string().optional().describe("Predmet"),
    body: z.string().optional().describe("Text v tele"),
    since: z.string().optional().describe("Od (YYYY-MM-DD)"),
    before: z.string().optional().describe("Do (YYYY-MM-DD)"),
    seen: z.boolean().optional().describe("true=prečítané, false=neprečítané"),
    flagged: z.boolean().optional(),
    limit: z.number().default(20),
  }, async ({ account, folder, from, to, subject, body, since, before, seen, flagged, limit }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const query = {};
        if (from) query.from = from;
        if (to) query.to = to;
        if (subject) query.subject = subject;
        if (body) query.body = body;
        if (since) query.since = new Date(since);
        if (before) query.before = new Date(before);
        if (seen === true) query.seen = true;
        if (seen === false) query.unseen = true;
        if (flagged === true) query.flagged = true;

        if (Object.keys(query).length === 0) query.all = true;

        const uids = await client.search(query, { uid: true });
        if (!uids?.length) return { content: [{ type: "text", text: `[${account}] ${folder}: Nič nenájdené.` }] };

        const selected = uids.slice(-Math.min(limit, 50));
        const uidRange = selected.join(",");
        const messages = [];
        for await (const msg of client.fetch(uidRange, { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
          messages.push(msg);
        }
        messages.sort((a, b) => new Date(b.envelope.date) - new Date(a.envelope.date));
        const lines = messages.map((msg, i) => `--- Email ${i + 1} ---\n${formatEmail(msg)}`);
        return { content: [{ type: "text", text: `[${account}] ${folder} — nájdených ${uids.length}, zobrazených ${messages.length}:\n\n${lines.join("\n\n")}` }] };
      } finally { lock.release(); }
    } catch (err) {
      const detail = err.responseStatus ? ` [${err.responseStatus}] ${err.responseText || ''}` : '';
      console.error(`[imap_search_emails] ${err.message}${detail}`);
      return { content: [{ type: "text", text: `Chyba: ${err.message}${detail}` }], isError: true };
    } finally {
      await client.logout().catch(() => {});
    }
  });

  // ── GET EMAIL (full) ──
  server.tool("imap_get_email", "Kompletný obsah emailu podľa UID.", {
    account: accountParam,
    folder: z.string().default("INBOX"),
    uid: z.number().describe("UID emailu"),
  }, async ({ account, folder, uid }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        let envelope, flags;
        const attachments = [];
        for await (const msg of client.fetch(String(uid), { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
          envelope = msg.envelope;
          flags = msg.flags;
          // Collect attachment info
          (function collect(s) {
            if (!s) return;
            if (s.disposition === "attachment" || (s.disposition === "inline" && s.filename)) {
              attachments.push({ filename: s.filename || "unknown", size: s.size || 0, part: s.part });
            }
            if (s.childNodes) s.childNodes.forEach(collect);
          })(msg.bodyStructure);
        }

        if (!envelope) throw new Error(`UID ${uid} nenájdený v ${folder}.`);

        let bodyText = "";
        try {
          const { content } = await client.download(String(uid), "1", { uid: true });
          const chunks = [];
          for await (const chunk of content) chunks.push(chunk);
          bodyText = Buffer.concat(chunks).toString("utf-8");
        } catch {
          try {
            const { content } = await client.download(String(uid), "1.1", { uid: true });
            const chunks = [];
            for await (const chunk of content) chunks.push(chunk);
            bodyText = Buffer.concat(chunks).toString("utf-8");
          } catch { bodyText = "(nepodarilo sa načítať telo správy)"; }
        }

        return { content: [{ type: "text", text: `[${account}] ${folder} — UID ${uid}:\n\n${formatEmail({ uid, envelope, flags, bodyText, attachments }, true)}` }] };
      } finally { lock.release(); }
    } catch (err) {
      const detail = err.responseStatus ? ` [${err.responseStatus}] ${err.responseText || ''}` : '';
      console.error(`[imap_get_email] ${err.message}${detail}`);
      return { content: [{ type: "text", text: `Chyba: ${err.message}${detail}` }], isError: true };
    } finally {
      await client.logout().catch(() => {});
    }
  });

  // ── MARK READ / UNREAD ──
  for (const [toolName, flag, add, label] of [
    ["imap_mark_as_read", "\\Seen", true, "prečítaný"],
    ["imap_mark_as_unread", "\\Seen", false, "neprečítaný"],
  ]) {
    server.tool(toolName, `Označí email ako ${label}.`, {
      account: accountParam, folder: z.string().default("INBOX"), uid: z.number(),
    }, async ({ account, folder, uid }) => {
      const client = await getImapClient(account);
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          if (add) await client.messageFlagsAdd(uid, [flag], { uid: true });
          else await client.messageFlagsRemove(uid, [flag], { uid: true });
          return { content: [{ type: "text", text: `[${account}] UID ${uid} označený ako ${label}.` }] };
        } finally { lock.release(); }
      } catch (err) {
        return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
      } finally { await client.logout().catch(() => {}); }
    });
  }

  // ── DELETE EMAIL ──
  server.tool("imap_delete_email", "Zmaže email (presunie do koša).", {
    account: accountParam, folder: z.string().default("INBOX"), uid: z.number(),
  }, async ({ account, folder, uid }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const folders = await client.list();
        const trash = folders.find((f) => f.specialUse === "\\Trash" || f.path.toLowerCase() === "trash");
        if (trash && folder.toLowerCase() !== trash.path.toLowerCase()) {
          await client.messageMove(uid, trash.path, { uid: true });
          return { content: [{ type: "text", text: `[${account}] UID ${uid} presunutý do ${trash.path}.` }] };
        } else {
          await client.messageFlagsAdd(uid, ["\\Deleted"], { uid: true });
          await client.messageDelete(uid, { uid: true });
          return { content: [{ type: "text", text: `[${account}] UID ${uid} trvalo zmazaný.` }] };
        }
      } finally { lock.release(); }
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally { await client.logout().catch(() => {}); }
  });

  // ── BULK DELETE ──
  server.tool("imap_bulk_delete", "Hromadné mazanie emailov.", {
    account: accountParam, folder: z.string().default("INBOX"),
    uids: z.array(z.number()).describe("Zoznam UID na zmazanie"),
  }, async ({ account, folder, uids }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const folders = await client.list();
        const trash = folders.find((f) => f.specialUse === "\\Trash" || f.path.toLowerCase() === "trash");
        let count = 0;

        for (let i = 0; i < uids.length; i += 50) {
          const batch = uids.slice(i, i + 50);
          const range = batch.join(",");
          if (trash && folder.toLowerCase() !== trash.path.toLowerCase()) {
            await client.messageMove(range, trash.path, { uid: true });
          } else {
            await client.messageFlagsAdd(range, ["\\Deleted"], { uid: true });
            await client.messageDelete(range, { uid: true });
          }
          count += batch.length;
        }

        return { content: [{ type: "text", text: `[${account}] ${folder}: Zmazaných ${count} emailov.` }] };
      } finally { lock.release(); }
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally { await client.logout().catch(() => {}); }
  });

  // ── MOVE EMAIL ──
  server.tool("imap_move_email", "Presunie email do iného priečinka.", {
    account: accountParam,
    folder: z.string().describe("Zdrojový priečinok"),
    uid: z.number(),
    destination: z.string().describe("Cieľový priečinok"),
  }, async ({ account, folder, uid, destination }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageMove(uid, destination, { uid: true });
        return { content: [{ type: "text", text: `[${account}] UID ${uid} presunutý z ${folder} do ${destination}.` }] };
      } finally { lock.release(); }
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally { await client.logout().catch(() => {}); }
  });

  // ── SEND EMAIL ──
  server.tool("imap_send_email", "Odošle email a uloží do Sent priečinka.", {
    account: accountParam,
    to: z.string().describe("Príjemca (viac oddeľ čiarkou)"),
    subject: z.string().describe("Predmet"),
    text: z.string().optional().describe("Text obsah"),
    html: z.string().optional().describe("HTML obsah"),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    replyTo: z.string().optional(),
    attachments: z.array(z.object({
      filename: z.string(),
      content: z.string().describe("Base64 obsah"),
      contentType: z.string().optional(),
    })).optional(),
  }, async ({ account, to, subject, text, html, cc, bcc, replyTo, attachments }) => {
    try {
      const acc = ACCOUNTS[account];
      if (!acc) throw new Error(`Účet "${account}" neexistuje.`);

      const transport = getSmtpTransport(account);
      const mailOptions = {
        from: acc.imap.user, to, subject,
        text: text || undefined, html: html || undefined,
        cc: cc || undefined, bcc: bcc || undefined,
        replyTo: replyTo || undefined,
      };

      if (attachments?.length) {
        mailOptions.attachments = attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content, "base64"),
          contentType: a.contentType || undefined,
        }));
      }

      const info = await transport.sendMail(mailOptions);

      // Save to Sent
      let sentInfo = "";
      try {
        const raw = await buildRawMessage({ ...mailOptions, from: acc.imap.user, messageId: info.messageId });
        const sentFolder = await saveToSent(account, raw);
        sentInfo = ` Uložené do ${sentFolder}.`;
      } catch (sentErr) {
        sentInfo = ` (Sent uloženie zlyhalo: ${sentErr.message})`;
      }

      return { content: [{ type: "text", text: `[${account}] Odoslané na ${to}. ID: ${info.messageId}.${sentInfo}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    }
  });

  // ── REPLY ──
  server.tool("imap_reply_to_email", "Odpovie na email a uloží do Sent.", {
    account: accountParam, folder: z.string().default("INBOX"),
    uid: z.number(), text: z.string().optional(), html: z.string().optional(),
    replyAll: z.boolean().default(false),
  }, async ({ account, folder, uid, text, html, replyAll }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      let envelope;
      try {
        for await (const msg of client.fetch(String(uid), { envelope: true }, { uid: true })) { envelope = msg.envelope; }
      } finally { lock.release(); }

      if (!envelope) throw new Error(`UID ${uid} nenájdený.`);

      const acc = ACCOUNTS[account];
      const transport = getSmtpTransport(account);

      let recipients = envelope.from?.map((f) => f.address).filter(Boolean) || [];
      if (replyAll && envelope.to) {
        recipients = [...recipients, ...envelope.to.map((t) => t.address).filter((a) => a && a !== acc.imap.user)];
      }

      const reSubject = envelope.subject?.startsWith("Re:") ? envelope.subject : `Re: ${envelope.subject || ""}`;
      const mailOptions = {
        from: acc.imap.user, to: recipients.join(", "), subject: reSubject,
        text: text || undefined, html: html || undefined,
        inReplyTo: envelope.messageId, references: envelope.messageId,
      };
      if (replyAll && envelope.cc) {
        mailOptions.cc = envelope.cc.map((c) => c.address).filter((a) => a && a !== acc.imap.user).join(", ");
      }

      const info = await transport.sendMail(mailOptions);

      let sentInfo = "";
      try {
        const raw = await buildRawMessage({ ...mailOptions, from: acc.imap.user, messageId: info.messageId });
        const sentFolder = await saveToSent(account, raw);
        sentInfo = ` Uložené do ${sentFolder}.`;
      } catch (sentErr) { sentInfo = ` (Sent: ${sentErr.message})`; }

      return { content: [{ type: "text", text: `[${account}] Odpoveď odoslaná na ${mailOptions.to}.${sentInfo}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally { await client.logout().catch(() => {}); }
  });

  // ── FORWARD ──
  server.tool("imap_forward_email", "Prepošle email a uloží do Sent.", {
    account: accountParam, folder: z.string().default("INBOX"),
    uid: z.number(), to: z.string(), text: z.string().optional().describe("Doplnkový text"),
  }, async ({ account, folder, uid, to, text: extra }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      let envelope;
      let bodyText = "";
      try {
        for await (const msg of client.fetch(String(uid), { envelope: true }, { uid: true })) { envelope = msg.envelope; }
        try {
          const { content } = await client.download(String(uid), "1", { uid: true });
          const chunks = [];
          for await (const chunk of content) chunks.push(chunk);
          bodyText = Buffer.concat(chunks).toString("utf-8");
        } catch { bodyText = "(nepodarilo sa načítať)"; }
      } finally { lock.release(); }

      if (!envelope) throw new Error(`UID ${uid} nenájdený.`);

      const acc = ACCOUNTS[account];
      const transport = getSmtpTransport(account);
      const fwdSubject = envelope.subject?.startsWith("Fwd:") ? envelope.subject : `Fwd: ${envelope.subject || ""}`;
      const fwdBody = [
        extra || "", "",
        "---------- Preposlaná správa ----------",
        `Od: ${envelope.from?.map((f) => `${f.name || ""} <${f.address}>`).join(", ") || "N/A"}`,
        `Dátum: ${envelope.date}`, `Predmet: ${envelope.subject || ""}`,
        `Komu: ${envelope.to?.map((t) => `${t.name || ""} <${t.address}>`).join(", ") || "N/A"}`,
        "", bodyText,
      ].join("\n");

      const mailOptions = { from: acc.imap.user, to, subject: fwdSubject, text: fwdBody };
      const info = await transport.sendMail(mailOptions);

      let sentInfo = "";
      try {
        const raw = await buildRawMessage({ ...mailOptions, from: acc.imap.user, messageId: info.messageId });
        const sentFolder = await saveToSent(account, raw);
        sentInfo = ` Uložené do ${sentFolder}.`;
      } catch (sentErr) { sentInfo = ` (Sent: ${sentErr.message})`; }

      return { content: [{ type: "text", text: `[${account}] Preposlané na ${to}.${sentInfo}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally { await client.logout().catch(() => {}); }
  });

  // ── DOWNLOAD ATTACHMENT ──
  server.tool("imap_download_attachment", "Stiahne prílohu z emailu. Pre textové prílohy (<100KB) vráti text priamo. Pre binárne/väčšie prílohy vráti download URL (platí 5 minút).", {
    account: accountParam, folder: z.string().default("INBOX"),
    uid: z.number(), part: z.string().describe("Part číslo prílohy"),
  }, async ({ account, folder, uid, part }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const { content, meta } = await client.download(String(uid), part, { uid: true });
        const chunks = [];
        for await (const chunk of content) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const filename = meta?.filename || `attachment_${uid}_${part}`;
        const contentType = meta?.contentType || "application/octet-stream";
        const sizeKB = (buffer.length / 1024).toFixed(1);

        // Textové prílohy menšie ako 100KB vrátime priamo
        if (contentType.startsWith("text/") && buffer.length < 100000) {
          return { content: [{ type: "text", text: `[${account}] Príloha ${filename} (${sizeKB} KB):\n\n${buffer.toString("utf-8")}` }] };
        }

        // Binárne/väčšie prílohy — uložíme do cache a vrátime download URL
        const token = randomUUID();
        attachmentCache.set(token, { buffer, filename, contentType, created: Date.now() });

        // Zistíme base URL servera
        const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : `http://localhost:${PORT}`;
        const downloadUrl = `${baseUrl}/attachment/${token}`;

        return { content: [{ type: "text", text: `[${account}] Príloha: ${filename} (${sizeKB} KB, ${contentType})\nDownload URL: ${downloadUrl}\nURL platí 5 minút. Po stiahnutí sa automaticky zmaže.` }] };
      } finally { lock.release(); }
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally { await client.logout().catch(() => {}); }
  });

  // ── ATTACHMENT BASE64 (pre programové spracovanie) ──
  server.tool("imap_get_attachment_base64", "Stiahne prílohu a vráti base64 obsah priamo v odpovedi. Používaj pre programové spracovanie príloh (uloženie na disk, konverzia). Pre veľké prílohy (>500KB) použi radšej imap_download_attachment s URL.", {
    account: accountParam, folder: z.string().default("INBOX"),
    uid: z.number(), part: z.string().describe("Part číslo prílohy"),
  }, async ({ account, folder, uid, part }) => {
    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const { content, meta } = await client.download(String(uid), part, { uid: true });
        const chunks = [];
        for await (const chunk of content) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const filename = meta?.filename || `attachment_${uid}_${part}`;
        const contentType = meta?.contentType || "application/octet-stream";
        const sizeKB = (buffer.length / 1024).toFixed(1);
        const b64 = buffer.toString("base64");

        return { content: [{ type: "text", text: `ATTACHMENT_META:${JSON.stringify({ filename, contentType, sizeKB })}\nATTACHMENT_BASE64:${b64}` }] };
      } finally { lock.release(); }
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally { await client.logout().catch(() => {}); }
  });

  // ── SPAM CHECK ──
  server.tool("imap_check_spam", "Kontrola emailov proti blacklistu spamových domén.", {
    account: accountParam, folder: z.string().default("INBOX"),
    domains: z.array(z.string()).optional().describe("Vlastný blacklist (inak vstavaný)"),
    limit: z.number().default(100),
  }, async ({ account, folder, domains, limit }) => {
    const blacklist = domains?.length ? domains : [
      "guerrillamail.com", "mailinator.com", "tempmail.com", "throwaway.email",
      "yopmail.com", "10minutemail.com", "trashmail.com", "fakeinbox.com",
      "sharklasers.com", "dispostable.com", "maildrop.cc", "temp-mail.org", "getnada.com",
    ];

    const client = await getImapClient(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const total = client.mailbox.exists;
        if (total === 0) return { content: [{ type: "text", text: `[${account}] ${folder}: Prázdny.` }] };

        const from = Math.max(total - limit + 1, 1);
        const spam = [];
        for await (const msg of client.fetch(`${from}:*`, { envelope: true, uid: true })) {
          const domain = msg.envelope?.from?.[0]?.address?.split("@")[1]?.toLowerCase();
          if (domain && blacklist.includes(domain)) {
            spam.push({ uid: msg.uid, from: msg.envelope.from[0].address, subject: msg.envelope.subject || "(bez predmetu)" });
          }
        }

        if (!spam.length) return { content: [{ type: "text", text: `[${account}] ${folder}: Žiadny spam (skontrolovaných ${Math.min(limit, total)}).` }] };

        const lines = spam.map((s) => `• UID ${s.uid} | ${s.from} | ${s.subject}`);
        return { content: [{ type: "text", text: `[${account}] ${folder}: ${spam.length} spam emailov:\n${lines.join("\n")}\n\nPouži imap_bulk_delete na zmazanie.` }] };
      } finally { lock.release(); }
    } catch (err) {
      return { content: [{ type: "text", text: `Chyba: ${err.message}` }], isError: true };
    } finally { await client.logout().catch(() => {}); }
  });

  return server;
}

// ─────────────────────────────────────────────
// TRANSPORT — Streamable HTTP (2025) + SSE fallback (2024)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// ATTACHMENT DOWNLOAD CACHE
// ─────────────────────────────────────────────
// In-memory cache pre stiahnuté prílohy. Token → { buffer, filename, contentType, created }
// Prílohy sa automaticky mažú po 5 minútach.
const attachmentCache = new Map();
const ATTACHMENT_TTL_MS = 5 * 60 * 1000; // 5 minút

function cleanExpiredAttachments() {
  const now = Date.now();
  for (const [token, entry] of attachmentCache) {
    if (now - entry.created > ATTACHMENT_TTL_MS) {
      attachmentCache.delete(token);
    }
  }
}

// Čistenie každú minútu
setInterval(cleanExpiredAttachments, 60 * 1000);

const TRANSPORT = process.env.TRANSPORT || "http";
const PORT = parseInt(process.env.PORT || "3000", 10);

if (TRANSPORT === "stdio") {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("IMAP MCP server — stdio režim.");
} else {
  const app = express();
  app.use(express.json());
  const transports = {};

  app.get("/health", (req, res) => {
    res.json({ status: "ok", accounts: Object.keys(ACCOUNTS).length, sessions: Object.keys(transports).length, uptime: process.uptime() });
  });

  // ── Attachment download endpoint ──
  app.get("/attachment/:token", (req, res) => {
    const entry = attachmentCache.get(req.params.token);
    if (!entry) {
      return res.status(404).json({ error: "Príloha nenájdená alebo expirovala (TTL 5 minút)." });
    }
    const contentType = entry.contentType || "application/octet-stream";
    const filename = entry.filename || "attachment";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Content-Length", entry.buffer.length);
    res.send(entry.buffer);
    // Po stiahnutí zmažeme z cache
    attachmentCache.delete(req.params.token);
  });

  // ── Streamable HTTP (protocol 2025-11-25) — /mcp ──
  app.all("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport;

      if (sessionId && transports[sessionId]) {
        const existing = transports[sessionId];
        if (existing instanceof StreamableHTTPServerTransport) {
          transport = existing;
        } else {
          res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Session uses different transport" }, id: null });
          return;
        }
      } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            console.error(`Streamable HTTP session: ${sid}`);
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };
        const server = createServer();
        await server.connect(transport);
      } else if (!sessionId && req.method === "GET") {
        // SSE fallback na /mcp pre staršie klienty
        const srv = createServer();
        const sseTransport = new SSEServerTransport("/mcp", res);
        transports[sseTransport.sessionId] = sseTransport;
        res.on("close", () => {
          delete transports[sseTransport.sessionId];
          srv.close().catch(() => {});
        });
        await srv.connect(sseTransport);
        return;
      } else if (sessionId && transports[sessionId] instanceof SSEServerTransport) {
        // POST pre existujúcu SSE session
        await transports[sessionId].handlePostMessage(req, res, req.body);
        return;
      } else {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session" }, id: null });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // ── Deprecated SSE (protocol 2024-11-05) — /sse + /messages ──
  app.get("/sse", async (req, res) => {
    const srv = createServer();
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    res.on("close", () => { delete transports[transport.sessionId]; srv.close().catch(() => {}); });
    await srv.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];
    if (transport instanceof SSEServerTransport) {
      await transport.handlePostMessage(req, res, req.body);
    } else {
      res.status(400).json({ error: "No SSE transport for this session" });
    }
  });

  app.listen(PORT, () => {
    console.error(`IMAP MCP server — port ${PORT}, účtov: ${Object.keys(ACCOUNTS).length}, transport: Streamable HTTP + SSE fallback`);
  });

  process.on("SIGINT", async () => {
    for (const sid in transports) {
      try { await transports[sid].close(); } catch {}
      delete transports[sid];
    }
    process.exit(0);
  });
}
