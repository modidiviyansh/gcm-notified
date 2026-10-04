# GCM Notified

WhatsApp messaging for a school, built on [WAHA](https://waha.devlike.pro) (GOWS engine).

- **WhatsApp groups**: bulk-send one message (with an image or PDF) to many WhatsApp groups, with random delays.
- **Personalised messages**: send to classes or sections synced from Frappe/ERPNext Education, to manual contact groups, or to an uploaded CSV. Messages can use variables such as `{{student_name}}` or `{{maths}}`.
- **Siblings**: a parent with several children gets either one merged message (`{{#each children}}…{{/each}}`) or one message per child.
- **Ban-risk controls**: per-number warm-up levels and daily caps, typing simulation, random delays with burst pauses, quiet hours, WhatsApp-existence checks, opt-outs (STOP / UNSUBSCRIBE), duplicate protection, and auto-pause when failures spike.
- **Alerts**: when a number disconnects, an alert is sent by WhatsApp (from another connected number) and by email.

One container (NestJS API + React dashboard), about 100 MB RAM. Data is stored in Postgres in its own `whatsapp` schema.

## Deploy

1. **Database**: in Supabase Studio → SQL Editor, set a password in [`db/00_create_schema.sql`](db/00_create_schema.sql) and run it. This creates the `gcm_notified` role and the `whatsapp` schema and touches nothing else. The app creates its own tables on first start.
2. **Image**: every push to `main` runs tests, builds `ghcr.io/<owner>/gcm-notified:latest` and triggers a Coolify redeploy (see [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)).
3. **Coolify**: create a Docker Image application from that image, port `3000`, a persistent volume at `/data`, and health check `/api/health`. Set the variables from [`.env.example`](.env.example).
4. Open the dashboard → **Numbers** → add a number → scan the QR code (or use a pairing code).

## Develop

```bash
cd server && npm install && npm run dev      # API on :3000 (needs the env vars, see .env.example)
cd web && npm install && npm run dev         # dashboard on :5173, proxies /api
cd server && npm test
```

Set `SENDING_ENABLED=false` for a dry run: everything works, but messages are logged instead of sent.

## Notes

- The send queue is a Postgres outbox with one sender loop per number (`FOR UPDATE SKIP LOCKED`). Restarts are safe, and messages that time out are never retried automatically, so nobody receives a message twice.
- WAHA webhooks are verified with HMAC-SHA512 (`WEBHOOK_SECRET`).
- Bulk messaging on unofficial WhatsApp clients can get numbers banned. Send only to people who expect to hear from you, keep caps conservative and warm new numbers up slowly.
