# Purhaven Back Office

ERP-style back office for Purhaven (UVCVTM Limited): warehouse, customers, suppliers, sales orders, purchase orders, goods in, despatch, products & stock, reports.

Deployed at **erp.purhaven.co.uk** (Vercel) with a dedicated Neon Postgres database.

## Stack
- Vercel serverless functions (Node 20+)
- Neon Postgres (separate project from the public site)
- Vanilla HTML + CSS frontend, dark theme
- Session-cookie auth (httpOnly, Secure, SameSite=Lax, 30-day TTL)
- PDFKit for paperwork
- Microsoft Graph for OneDrive archive (Phase 1 task #53)

## First-run setup

1. **Create the Neon project**, copy its `DATABASE_URL`.
2. **Create the Vercel project** linked to `BAR3571/purhaven-erp`.
3. **Set Vercel env vars**:
   - `DATABASE_URL` — Neon connection string
   - `MIGRATION_TOKEN` — long random string, used for `/api/admin/migrate` and `/api/auth/setup`
   - `SMTP_HOST=smtpout.secureserver.net`
   - `SMTP_PORT=465`
   - `SMTP_USER=sales@uvcvtm.com`
   - `SMTP_PASSWORD=<inbox app password>`
4. **Deploy**. First deploy will fail until env vars are set.
5. **Run the migration**:
   ```sh
   curl -X POST https://erp.purhaven.co.uk/api/admin/migrate \
     -H "Authorization: Bearer $MIGRATION_TOKEN"
   ```
6. **Create your admin user**:
   ```sh
   curl -X POST https://erp.purhaven.co.uk/api/auth/setup \
     -H "Authorization: Bearer $MIGRATION_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"email":"john@uvcvtm.com","password":"<10+ char password>","name":"John","role":"admin"}'
   ```
7. **Add the DNS record** in GoDaddy: `CNAME erp` → the value Vercel shows for the domain.
8. Sign in at `https://erp.purhaven.co.uk/login`.

## Repo layout
```
api/
  health.js
  auth/        login, logout, me, setup
  admin/       migrate (+ further modules as they ship)
lib/
  db.js        Neon client
  session.js   cookie auth helpers
scripts/       one-off scripts (seeders, dev tools)
*.html         pages
styles.css     dark theme
```

## Phase plan
- **Phase 1** Customers · Suppliers · Products & Stock · Sales Orders · Purchase Orders · Goods In · Despatch (+ paperwork PDFs + OneDrive archive) · basic reports · warehouse dashboard
- **Phase 2** Barcode scan flow · full reports suite
- **Phase 3** Xero integration (invoices + contacts, one-way push)
