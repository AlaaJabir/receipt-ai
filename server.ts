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
const EXCHANGE_RATE_API_URL = 'https://api.frankfurter.dev/v2/rate';
const LATEST_RATE_CACHE_MS = 60 * 60 * 1000;

type CachedRate = {
  expiresAt: number;
  promise: Promise<{ rate: number; date: string }>;
};

const exchangeRateCache = new Map<string, CachedRate>();

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

function normalizeDate(value: unknown): string | null {
  const parsed = parseReceiptDate(value ? String(value) : null);
  return parsed ? parsed.toISOString().slice(0, 10) : null;
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
  const originalCurrency = normalizeCurrency(payload.original_currency ?? payload.currency);
  const originalTotal = parseMoney(payload.original_total ?? payload.total);
  const originalHt = parseMoney(payload.original_ht ?? payload.ht);
  const originalTva = parseMoney(payload.original_tva ?? payload.tva);
  const receiptDate = normalizeDate(payload.receipt_date ?? payload.date);

  return {
    merchant: payload.merchant ? String(payload.merchant).trim() : null,
    transaction_ref: payload.transaction_ref ? String(payload.transaction_ref).trim() : null,
    date: receiptDate,
    receipt_date: receiptDate,
    category: normalizeCategory(payload.category),
    total: originalTotal,
    currency: originalCurrency,
    ht: originalHt,
    tva: originalTva,
    original_currency: originalCurrency,
    original_total: originalTotal,
    original_ht: originalHt,
    original_tva: originalTva,
    insight: payload.insight ? String(payload.insight).trim() : null,
    status: normalizeStatus(payload.status),
    file_name: file?.originalname || null,
    file_type: file?.mimetype || null,
  };
}

type ConversionResult = {
  display_currency: string;
  converted_total: number | null;
  converted_ht: number | null;
  converted_tva: number | null;
  exchange_rate: number | null;
  exchange_rate_date: string | null;
  exchange_rate_source: 'historical' | 'latest' | 'identity' | 'failed';
};

function roundMoney(value: number | null, rate: number): number | null {
  return value === null ? null : Math.round(value * rate * 100) / 100;
}

async function requestExchangeRate(base: string, quote: string, date?: string) {
  const cacheKey = `${base}:${quote}:${date || 'latest'}`;
  const cached = exchangeRateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const url = new URL(`${EXCHANGE_RATE_API_URL}/${encodeURIComponent(base)}/${encodeURIComponent(quote)}`);
  if (date) url.searchParams.set('date', date);

  const promise = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Exchange-rate API returned ${response.status}.`);

    const data = await response.json() as { rate?: number; date?: string };
    if (!Number.isFinite(data.rate) || !data.date) throw new Error('Exchange-rate API returned an invalid rate.');
    return { rate: Number(data.rate), date: data.date };
  })();

  exchangeRateCache.set(cacheKey, {
    promise,
    expiresAt: date ? Number.MAX_SAFE_INTEGER : Date.now() + LATEST_RATE_CACHE_MS,
  });

  try {
    return await promise;
  } catch (error) {
    exchangeRateCache.delete(cacheKey);
    throw error;
  }
}

async function convertReceiptValues(
  receipt: ReturnType<typeof normalizeReceipt>,
  displayCurrencyValue: unknown,
): Promise<ConversionResult> {
  const displayCurrency = normalizeCurrency(displayCurrencyValue || 'MAD');
  const originalCurrency = receipt.original_currency;

  if (originalCurrency === displayCurrency) {
    return {
      display_currency: displayCurrency,
      converted_total: receipt.original_total,
      converted_ht: receipt.original_ht,
      converted_tva: receipt.original_tva,
      exchange_rate: 1,
      exchange_rate_date: receipt.receipt_date,
      exchange_rate_source: 'identity',
    };
  }

  try {
    let rateResult: { rate: number; date: string };
    let source: ConversionResult['exchange_rate_source'] = 'historical';

    try {
      if (!receipt.receipt_date) throw new Error('Receipt date unavailable.');
      rateResult = await requestExchangeRate(originalCurrency, displayCurrency, receipt.receipt_date);
    } catch {
      rateResult = await requestExchangeRate(originalCurrency, displayCurrency);
      source = 'latest';
    }

    return {
      display_currency: displayCurrency,
      converted_total: roundMoney(receipt.original_total, rateResult.rate),
      converted_ht: roundMoney(receipt.original_ht, rateResult.rate),
      converted_tva: roundMoney(receipt.original_tva, rateResult.rate),
      exchange_rate: rateResult.rate,
      exchange_rate_date: rateResult.date,
      exchange_rate_source: source,
    };
  } catch (error) {
    console.error(`Currency conversion failed for ${originalCurrency}/${displayCurrency}:`, error);
    return {
      display_currency: displayCurrency,
      converted_total: null,
      converted_ht: null,
      converted_tva: null,
      exchange_rate: null,
      exchange_rate_date: null,
      exchange_rate_source: 'failed',
    };
  }
}

function logConversion(context: string, receipt: Record<string, any>, conversion: ConversionResult) {
  console.info(`[currency:${context}]`, {
    receipt_id: receipt.id || null,
    original_total: receipt.original_total ?? receipt.total ?? null,
    original_currency: receipt.original_currency ?? receipt.currency ?? null,
    converted_total: conversion.converted_total,
    display_currency: conversion.display_currency,
    exchange_rate: conversion.exchange_rate,
    exchange_rate_source: conversion.exchange_rate_source,
  });
}

function needsConversion(receipt: Record<string, any>, displayCurrency: string): boolean {
  const originalCurrency = normalizeCurrency(receipt.original_currency ?? receipt.currency);
  const originalTotal = parseMoney(receipt.original_total ?? receipt.total);
  const originalTva = parseMoney(receipt.original_tva ?? receipt.tva);
  const convertedTotal = parseMoney(receipt.converted_total);
  const convertedTva = parseMoney(receipt.converted_tva);
  const exchangeRate = parseMoney(receipt.exchange_rate);
  const totalDoesNotMatchRate = originalTotal !== null
    && convertedTotal !== null
    && exchangeRate !== null
    && Math.abs(convertedTotal - roundMoney(originalTotal, exchangeRate)!) > 0.01;
  const tvaDoesNotMatchRate = originalTva !== null
    && convertedTva !== null
    && exchangeRate !== null
    && Math.abs(convertedTva - roundMoney(originalTva, exchangeRate)!) > 0.01;

  return receipt.display_currency !== displayCurrency
    || receipt.exchange_rate_source === 'failed'
    || (originalCurrency !== displayCurrency && (receipt.exchange_rate_source === 'identity' || exchangeRate === 1))
    || (originalTotal !== null && convertedTotal === null)
    || (originalTva !== null && convertedTva === null)
    || exchangeRate === null
    || totalDoesNotMatchRate
    || tvaDoesNotMatchRate;
}

async function ensureReceiptConversion(receipt: Record<string, any>, displayCurrency: string) {
  if (!needsConversion(receipt, displayCurrency)) return receipt;

  const normalized = normalizeReceipt(receipt);
  const conversion = await convertReceiptValues(normalized, displayCurrency);
  logConversion('fallback', receipt, conversion);

  const updateResult = await (getSupabase() as any)
    .from('receipts')
    .update({ ...conversion, updated_at: new Date().toISOString() })
    .eq('id', receipt.id)
    .select()
    .single();

  if (updateResult.error) {
    console.error(`[currency:persist-failed] receipt=${receipt.id}`, updateResult.error.message);
    return { ...receipt, ...conversion };
  }

  return updateResult.data;
}

function getMissingColumn(message: string): string | null {
  const schemaCacheMatch = message.match(/Could not find the '([^']+)' column/i);
  if (schemaCacheMatch) return schemaCacheMatch[1];

  const postgresMatch = message.match(/column ["']?([a-zA-Z0-9_]+)["']? (?:does not exist|of relation .* does not exist)/i);
  return postgresMatch?.[1] || null;
}

async function insertReceiptWithSchemaFallback(receiptPayload: Record<string, unknown>) {
  const compatiblePayload = { ...receiptPayload };

  for (let attempt = 0; attempt <= Object.keys(receiptPayload).length; attempt += 1) {
    const result = await getSupabase()
      .from('receipts')
      .insert([compatiblePayload] as any)
      .select()
      .single();

    if (!result.error) return result;

    const missingColumn = getMissingColumn(result.error.message);
    if (!missingColumn || !(missingColumn in compatiblePayload)) return result;
    delete compatiblePayload[missingColumn];
  }

  throw new Error('Unable to create a receipt with the deployed Supabase schema.');
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
  const numericFields = [
    'total',
    'ht',
    'tva',
    'original_total',
    'original_ht',
    'original_tva',
    'converted_total',
    'converted_ht',
    'converted_tva',
    'exchange_rate',
  ];
  const normalized = { ...receipt };
  for (const field of numericFields) {
    normalized[field] = receipt[field] === null || receipt[field] === undefined ? null : Number(receipt[field]);
  }

  return {
    ...normalized,
    conversion_warning: receipt.exchange_rate_source === 'failed'
      ? `Could not convert ${receipt.original_currency || receipt.currency || 'receipt currency'} to ${receipt.display_currency || 'dashboard currency'}.`
      : null,
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
    const { month, category, status, search, from, to, display_currency } = req.query as Record<string, string | undefined>;
    const displayCurrency = normalizeCurrency(display_currency || 'MAD');
    let query = getSupabase().from('receipts').select('*').order('created_at', { ascending: false });

    if (category && category !== 'All') query = query.eq('category', category);
    if (status && status !== 'All') query = query.eq('status', status);
    if (search) {
      const term = `%${search}%`;
      query = query.or(`merchant.ilike.${term},category.ilike.${term},date.ilike.${term},status.ilike.${term},transaction_ref.ilike.${term}`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const filteredReceipts = ((data || []) as Array<Record<string, any>>)
      .filter(receipt => matchesDateFilters(receipt, month, from, to));
    const convertedReceipts = await Promise.all(
      filteredReceipts.map(receipt => ensureReceiptConversion(receipt, displayCurrency)),
    );
    const receipts = convertedReceipts.map(getPublicReceipt);

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
              text: `You are ReceiptAI, a precise finance data extractor for business receipts.
Use null for missing fields. Numeric fields must be numbers, not strings.
Normalize DH, DHS, and dirham to MAD when possible.
Extract monetary values exactly as printed. Never convert currencies.
receipt_date must be YYYY-MM-DD when the date is unambiguous, otherwise null.
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
              receipt_date: { type: ['string', 'null'] },
              category: { type: 'string', enum: CATEGORIES },
              original_total: { type: ['number', 'null'] },
              original_currency: { type: ['string', 'null'] },
              original_ht: { type: ['number', 'null'] },
              original_tva: { type: ['number', 'null'] },
              insight: { type: ['string', 'null'] },
              status: { type: 'string', enum: ['Pending Approval'] },
            },
            required: ['merchant', 'transaction_ref', 'receipt_date', 'category', 'original_total', 'original_currency', 'original_ht', 'original_tva', 'insight', 'status'],
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

    const normalizedReceipt = normalizeReceipt({ ...parsed, status: 'Pending Approval' }, file);
    const conversion = await convertReceiptValues(normalizedReceipt, req.body.display_currency);
    logConversion('upload', normalizedReceipt, conversion);
    const receiptPayload = { ...normalizedReceipt, ...conversion };
    const { data, error } = await insertReceiptWithSchemaFallback(receiptPayload);

    if (error) return res.status(500).json({ error: `Failed to save to Supabase: ${error.message}` });
    res.json({ receipt: getPublicReceipt(data) });
  } catch (err: any) {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File is too large. Maximum size is 12MB.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/receipts/reconvert', async (req, res) => {
  try {
    const displayCurrency = normalizeCurrency(req.body.display_currency || 'MAD');
    const { data: receipts, error } = await getSupabase().from('receipts').select('*');
    if (error) return res.status(500).json({ error: error.message });

    const convertedReceipts = [];
    for (const receipt of (receipts || []) as Array<Record<string, any>>) {
      const normalized = normalizeReceipt(receipt);
      const conversion = await convertReceiptValues(normalized, displayCurrency);
      logConversion('reconvert', receipt, conversion);
      const updateResult = await (getSupabase() as any)
        .from('receipts')
        .update({ ...conversion, updated_at: new Date().toISOString() })
        .eq('id', receipt.id)
        .select()
        .single();
      if (updateResult.error) return res.status(500).json({ error: updateResult.error.message });
      convertedReceipts.push(getPublicReceipt(updateResult.data));
    }

    res.json({ receipts: convertedReceipts });
  } catch (err: any) {
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
    const currentResult = await (getSupabase() as any).from('receipts').select('*').eq('id', req.params.id).single();
    if (currentResult.error) return res.status(404).json({ error: currentResult.error.message });
    if (!currentResult.data) return res.status(404).json({ error: 'Receipt not found.' });
    const currentReceipt = currentResult.data as Record<string, any>;

    const originalValuesChanged = ['date', 'total', 'currency', 'ht', 'tva'].some(key => key in updates);
    const normalized = normalizeReceipt({
      ...currentReceipt,
      ...updates,
      original_total: updates.total ?? currentReceipt.original_total,
      original_currency: updates.currency ?? currentReceipt.original_currency,
      original_ht: updates.ht ?? currentReceipt.original_ht,
      original_tva: updates.tva ?? currentReceipt.original_tva,
      receipt_date: updates.date ?? currentReceipt.receipt_date,
    });
    const conversion = originalValuesChanged
      ? await convertReceiptValues(normalized, req.body.display_currency || currentReceipt.display_currency)
      : {};
    if (originalValuesChanged) logConversion('update', currentReceipt, conversion as ConversionResult);
    const payload = {
      ...normalized,
      ...conversion,
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
    const originalCurrency = receipt.original_currency || receipt.currency || 'MAD';
    const displayCurrency = receipt.display_currency || 'MAD';

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
    doc.text(`Original HT: ${receipt.original_ht ?? receipt.ht ?? '---'} ${originalCurrency}`, 30, 116);
    doc.text(`Original TVA: ${receipt.original_tva ?? receipt.tva ?? '---'} ${originalCurrency}`, 30, 126);
    doc.setFontSize(15);
    doc.text(`Original total: ${receipt.original_total ?? receipt.total ?? '---'} ${originalCurrency}`, 30, 138);
    doc.setFontSize(11);
    doc.text(
      receipt.converted_total === null
        ? 'Converted total: unavailable'
        : `Converted total: ${receipt.converted_total} ${displayCurrency}`,
      30,
      148,
    );

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
