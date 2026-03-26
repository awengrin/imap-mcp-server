# IMAP MCP Server — Digital Berry

Vlastný MCP server pre emailovú komunikáciu cez IMAP a SMTP. Multi-tenant podpora, automatické ukladanie odoslaných emailov do Sent folderu.

## Funkcie

- Multi-tenant: 5–10+ emailových účtov cez environment variables
- Automatický save-to-sent po každom odoslaní (auto-detekcia Sent folderu)
- Čítanie, vyhľadávanie, odpovedanie, preposielanie emailov
- Hromadné mazanie (bulk delete)
- Spam detekcia (doménový blacklist)
- Presun emailov medzi priečinkami
- Sťahovanie príloh
- Factory pattern pre SSE (produkčne overený)

## Konfigurácia účtov

Každý účet sa konfiguruje cez environment variables s prefixom `IMAP_ACCOUNT_<MENO>_`:

```
IMAP_ACCOUNT_INFO_HOST=imap.example.com
IMAP_ACCOUNT_INFO_PORT=993
IMAP_ACCOUNT_INFO_USER=info@digitalberry.sk
IMAP_ACCOUNT_INFO_PASS=heslo
IMAP_ACCOUNT_INFO_SMTP_HOST=smtp.example.com
IMAP_ACCOUNT_INFO_SMTP_PORT=465
IMAP_ACCOUNT_INFO_SMTP_SECURE=true
IMAP_ACCOUNT_INFO_SENT_FOLDER=Sent  # voliteľné
```

## Deployment na Railway

1. Push na GitHub
2. Nový projekt na Railway z GitHub repo
3. Nastaviť env vars: TRANSPORT=http, PORT (auto), všetky IMAP_ACCOUNT_* premenné
4. Deploy — Dockerfile sa deteguje automaticky

## Pripojenie v claude.ai

Settings → Integrations → Add Integration
URL: `https://tvoj-server.up.railway.app/mcp`

## Tooly (17)

- `list_accounts` — zoznam účtov
- `imap_list_folders` — priečinky
- `imap_folder_status` — stav priečinka
- `imap_get_unread_count` — neprečítané
- `imap_get_latest_emails` — najnovšie emaily
- `imap_search_emails` — vyhľadávanie
- `imap_get_email` — kompletný obsah
- `imap_mark_as_read` — označiť prečítané
- `imap_mark_as_unread` — označiť neprečítané
- `imap_delete_email` — zmazať
- `imap_bulk_delete` — hromadné mazanie
- `imap_move_email` — presun
- `imap_send_email` — odoslať (+ save to sent)
- `imap_reply_to_email` — odpovedať (+ save to sent)
- `imap_forward_email` — preposlať (+ save to sent)
- `imap_download_attachment` — stiahnuť prílohu
- `imap_check_spam` — spam detekcia

## Lokálny vývoj

```bash
npm install
TRANSPORT=stdio node server.mjs
```
