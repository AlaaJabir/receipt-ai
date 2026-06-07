# ReceiptAI

ReceiptAI is a production-ready AI receipt and expense dashboard built with React, Vite, TypeScript, Tailwind CSS, Express, Supabase, OpenAI, Recharts, lucide-react, multer, and jsPDF.

Users can upload JPG, PNG, or PDF receipts. The backend validates the file, sends it to OpenAI, normalizes the extracted JSON, stores it in Supabase, and returns live dashboard data with filters, approval workflow, editing, deleting, analytics, settings, and PDF export.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local` from `.env.example` and fill:

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
```

3. Run the Supabase migration:

```sql
supabase/migrations/20260604000000_create_receipts.sql
```

You can paste it into the Supabase SQL editor or run it with the Supabase CLI.

4. Start the app:

```bash
npm run dev
```

The frontend and backend run together at `http://localhost:3000`.

## API

- `GET /api/health`
- `GET /api/receipts?month=YYYY-MM&category=Meals&status=Approved&search=term&from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/receipts/:id`
- `POST /api/receipts/process` with multipart field `receipt`
- `PATCH /api/receipts/:id`
- `PATCH /api/receipts/:id/status`
- `DELETE /api/receipts/:id`
- `GET /api/receipts/:id/export-pdf`

## Validation Checklist

- `npm install` installs dependencies.
- `npm run dev` starts the Express API and Vite app.
- `GET /api/health` reports API status and Supabase connection status.
- Uploading a JPG, PNG, or PDF creates a `public.receipts` row.
- Filters, search, month, category, and status update real API data.
- Receipt rows open the detail panel.
- Approve, reject, pending, edit, delete, and PDF export call backend routes.
- Analytics and settings navigation are functional.
- Settings are stored in `localStorage` when auth is not configured.
