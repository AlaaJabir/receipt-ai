import express from 'express';
import path from 'path';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const CATEGORIES = ['Meals', 'Transport', 'Software', 'Office', 'Fuel', 'Travel', 'Utilities', 'Other'];
const STATUSES = ['Pending Approval', 'Approved', 'Rejected'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new Error('Invalid file type. Upload a JPG, PNG, or PDF receipt.'));
      return;
    }
    cb(null, true);
  },
});

let supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be defined in the environment.');
    }
    supabase = createClient(supabaseUrl, supabaseKey);
  }
  return supabase;
}

let ai: OpenAI | null = null;
function getAI() {
  if (!ai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY must be defined in the environment.');
    }
    ai = new OpenAI({ apiKey });
  }
  return ai;
}

function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value)
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(/,(?=\d{1,2}$)/, '.')
    .replace(/,/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCurrency(value: unknown): string {
  const currency = String(value || 'MAD').trim().toUpperCase();
  if (['DH', 'DHS', 'MAD', 'MAD.'].includes(currency)) return 'MAD';
  return currency || 'MAD';
}

function normalizeCategory(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  const match = CATEGORIES.find(category => category.toLowerCase() === raw);
  return match || 'Other';
}

function normalizeStatus(value: unknown): string {
  const raw = String(value || '').trim();
  return STATUSES.includes(raw) ? raw : 'Pending Approval';
}

function normalizeReceipt(payload: Record<string, unknown>, file?: Express.Multer.File) {
  return {
    merchant: payload.merchant ? String(payload.merchant).trim() : null,
    transaction_ref: payload.transaction_ref ? String(payload.transaction_ref).trim() : null,
    date: payload.date ? String(payload.date).trim() : null,
    category: normalizeCategory(payload.category),
    total: parseMoney(payload.total),
    currency: normalizeCurrency(payload.currency),
    ht: parseMoney(payload.ht),
    tva: parseMoney(payload.tva),
    insight: payload.insight ? String(payload.insight).trim() : null,
    status: normalizeStatus(payload.status),
    file_name: file?.originalname || null,
    file_type: file?.mimetype || null,
  };
}

function parseReceiptDate(dateText: string | null | undefined): Date | null {
  if (!dateText) return null;
  const direct = new Date(dateText);
  if (!Number.isNaN(direct.getTime())) return direct;
  const match = dateText.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  const day = first > 12 ? first : second;
  const month = first > 12 ? second : first;
  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function matchesDateFilters(receipt: any, month?: string, from?: string, to?: string) {
  if (!month && !from && !to) return true;
  const parsed = parseReceiptDate(receipt.date) || parseReceiptDate(receipt.created_at);
  if (!parsed) return false;

  if (month) {
    const normalizedMonth = month.length === 7 ? month : month.slice(0, 7);
    const receiptMonth = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
    if (receiptMonth !== normalizedMonth) return false;
  }

  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime()) && parsed < fromDate) return false;
  }

  if (to) {
    const toDate = new Date(to);
    if (!Number.isNaN(toDate.getTime())) {
      toDate.setHours(23, 59, 59, 999);
      if (parsed > toDate) return false;
    }
  }

  return true;
}

function getPublicReceipt(receipt: any) {
  return {
    ...receipt,
    total: receipt.total === null ? null : Number(receipt.total),
    ht: receipt.ht === null ? null : Number(receipt.ht),
    tva: receipt.tva === null ? null : Number(receipt.tva),
  };
}

app.get('/api/health', async (_req, res) => {
  const env = {
    supabaseUrl: Boolean(process.env.SUPABASE_URL),
    supabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    openaiApiKey: Boolean(process.env.OPENAI_API_KEY),
  };

  let supabaseStatus = 'not_configured';
  if (env.supabaseUrl && env.supabaseServiceRoleKey) {
    try {
      const { error } = await getSupabase().from('receipts').select('id', { count: 'exact', head: true });
      supabaseStatus = error ? `error: ${error.message}` : 'ok';
    } catch (err: any) {
      supabaseStatus = `error: ${err.message}`;
    }
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    supabase: supabaseStatus,
    env,
  });
});

app.get('/api/receipts', async (req, res) => {
  try {
    const { month, category, status, search, from, to } = req.query as Record<string, string | undefined>;
    let query = getSupabase().from('receipts').select('*').order('created_at', { ascending: false });

    if (category && category !== 'All') query = query.eq('category', category);
    if (status && status !== 'All') query = query.eq('status', status);
    if (search) {
      const term = `%${search}%`;
      query = query.or(`merchant.ilike.${term},category.ilike.${term},date.ilike.${term},status.ilike.${term},transaction_ref.ilike.${term}`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const receipts = (data || [])
      .filter(receipt => matchesDateFilters(receipt, month, from, to))
      .map(getPublicReceipt);

    res.json({ receipts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/receipts/:id', async (req, res) => {
  try {
    const { data, error } = await getSupabase().from('receipts').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: error.message });
    res.json({ receipt: getPublicReceipt(data) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/receipts/process', upload.single('receipt'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Receipt file is required.' });
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Upload a JPG, PNG, or PDF receipt.' });
    }

    const base64File = file.buffer.toString('base64');
    const fileInput = file.mimetype === 'application/pdf'
      ? {
          type: 'input_file' as const,
          filename: file.originalname,
          file_data: `data:application/pdf;base64,${base64File}`,
        }
      : {
          type: 'input_image' as const,
          image_url: `data:${file.mimetype};base64,${base64File}`,
          detail: 'high' as const,
        };

    const aiResponse = await getAI().responses.create({
      model: 'gpt-5-mini',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `You are ReceiptAI, a precise finance data extractor for Moroccan business receipts.
Use null for missing fields. Numeric fields must be numbers, not strings.
Normalize DH, DHS, and dirham to MAD when possible.
The category must be exactly one of: Meals, Transport, Software, Office, Fuel, Travel, Utilities, Other.
The status must be Pending Approval.`,
            },
            fileInput,
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'receipt',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              merchant: { type: ['string', 'null'] },
              transaction_ref: { type: ['string', 'null'] },
              date: { type: ['string', 'null'] },
              category: { type: 'string', enum: CATEGORIES },
              total: { type: ['number', 'null'] },
              currency: { type: ['string', 'null'] },
              ht: { type: ['number', 'null'] },
              tva: { type: ['number', 'null'] },
              insight: { type: ['string', 'null'] },
              status: { type: 'string', enum: ['Pending Approval'] },
            },
            required: ['merchant', 'transaction_ref', 'date', 'category', 'total', 'currency', 'ht', 'tva', 'insight', 'status'],
          },
        },
      },
    });

    const aiText = aiResponse.output_text || '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(aiText);
    } catch {
      return res.status(502).json({ error: 'OpenAI returned invalid JSON.', rawText: aiText });
    }

    const receiptPayload = normalizeReceipt({ ...parsed, status: 'Pending Approval' }, file);
    const { data, error } = await getSupabase()
      .from('receipts')
      .insert([receiptPayload] as any)
      .select()
      .single();

    if (error) return res.status(500).json({ error: `Failed to save to Supabase: ${error.message}` });
    res.json({ receipt: getPublicReceipt(data) });
  } catch (err: any) {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File is too large. Maximum size is 12MB.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/receipts/:id', async (req, res) => {
  try {
    const allowed = ['merchant', 'transaction_ref', 'date', 'category', 'total', 'currency', 'ht', 'tva', 'insight', 'status'];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    const normalized = normalizeReceipt(updates);
    const payload = {
      ...normalized,
      file_name: undefined,
      file_type: undefined,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await (getSupabase() as any)
      .from('receipts')
      .update(payload)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ receipt: getPublicReceipt(data) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/receipts/:id/status', async (req, res) => {
  try {
    const status = normalizeStatus(req.body.status);
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

    const { data, error } = await (getSupabase() as any)
      .from('receipts')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ receipt: getPublicReceipt(data) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/receipts/:id', async (req, res) => {
  try {
    const { error } = await getSupabase().from('receipts').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/receipts/:id/export-pdf', async (req, res) => {
  try {
    const { data, error } = await getSupabase().from('receipts').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: error.message });

    const { jsPDF } = await import('jspdf');
    const receipt = getPublicReceipt(data);
    const doc = new jsPDF();
    const ref = (receipt.transaction_ref || receipt.id || '').slice(0, 12).toUpperCase();
    const currency = receipt.currency || 'MAD';

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text('ReceiptAI Summary', 20, 22);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(90);
    doc.text(`Generated ${new Date().toLocaleString()}`, 20, 30);

    doc.setDrawColor(220);
    doc.roundedRect(20, 42, 170, 104, 3, 3);
    doc.setTextColor(0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(receipt.merchant || 'Unknown merchant', 30, 58);

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Reference: ${ref || 'N/A'}`, 30, 68);
    doc.text(`Date: ${receipt.date || 'N/A'}`, 30, 76);
    doc.text(`Category: ${receipt.category || 'Other'}`, 30, 84);
    doc.text(`Status: ${receipt.status || 'Pending Approval'}`, 30, 92);

    doc.line(30, 102, 180, 102);
    doc.setFont('helvetica', 'bold');
    doc.text(`HT: ${receipt.ht ?? '---'} ${currency}`, 30, 116);
    doc.text(`TVA: ${receipt.tva ?? '---'} ${currency}`, 30, 126);
    doc.setFontSize(15);
    doc.text(`Total TTC: ${receipt.total ?? '---'} ${currency}`, 30, 138);

    if (receipt.insight) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.text(doc.splitTextToSize(`AI insight: ${receipt.insight}`, 20, { maxWidth: 170 }), 20, 164);
    }

    const pdf = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ReceiptAI_${ref || receipt.id}.pdf"`);
    res.send(pdf);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('API request failed:', err);

  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File is too large. Maximum size is 12MB.' });
  }

  const message = err instanceof Error ? err.message : 'Internal server error.';
  const status = message.startsWith('Invalid file type.') ? 400 : 500;
  return res.status(status).json({ error: message });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ReceiptAI server running on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export { app };
