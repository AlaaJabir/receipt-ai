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

function getDisplayCurrency(value: unknown): string | null {
  const currency = normalizeCurrency(value || 'MAD');
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function debugServer(label: string, details: unknown) {
  if (process.env.NODE_ENV !== 'production') console.debug(`[ReceiptAI:${label}]`, details);
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

function normalizedMerchant(value: unknown): string {
  return String(value || '').trim().toLocaleLowerCase();
}

async function findDuplicateReceipts(receipt: ReturnType<typeof normalizeReceipt>, excludeId?: string) {
  let query = (getSupabase() as any)
    .from('receipts')
    .select('id, merchant, receipt_date, original_total, original_currency, original_tva, created_at');

  query = receipt.receipt_date === null
    ? query.is('receipt_date', null)
    : query.eq('receipt_date', receipt.receipt_date);
  query = receipt.original_total === null
    ? query.is('original_total', null)
    : query.eq('original_total', receipt.original_total);
  query = query.eq('original_currency', receipt.original_currency);
  query = receipt.original_tva === null
    ? query.is('original_tva', null)
    : query.eq('original_tva', receipt.original_tva);

  const { data, error } = await query;
  if (error) throw new Error(`Duplicate check failed: ${error.message}`);

  const merchant = normalizedMerchant(receipt.merchant);
  return ((data || []) as Array<Record<string, any>>).filter(candidate =>
    candidate.id !== excludeId && normalizedMerchant(candidate.merchant) === merchant,
  );
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

type ConversionRateMode = 'latest' | 'historical';

function getConversionRateMode(value: unknown): ConversionRateMode {
  return value === 'historical' ? 'historical' : 'latest';
}

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
  rateModeValue: unknown = 'latest',
): Promise<ConversionResult> {
  const displayCurrency = normalizeCurrency(displayCurrencyValue || 'MAD');
  const originalCurrency = receipt.original_currency;
  const rateMode = getConversionRateMode(rateModeValue);

  if (originalCurrency === displayCurrency) {
    return {
      display_currency: displayCurrency,
      converted_total: receipt.original_total,
      converted_ht: receipt.original_ht,
      converted_tva: receipt.original_tva,
      exchange_rate: 1,
      exchange_rate_date: rateMode === 'historical'
        ? receipt.receipt_date
        : new Date().toISOString().slice(0, 10),
      exchange_rate_source: 'identity',
    };
  }

  try {
    let rateResult: { rate: number; date: string };
    let source: ConversionResult['exchange_rate_source'];

    if (rateMode === 'historical') {
      if (!receipt.receipt_date) throw new Error('Receipt date unavailable for historical conversion.');
      rateResult = await requestExchangeRate(originalCurrency, displayCurrency, receipt.receipt_date);
      source = 'historical';
    } else {
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

function needsConversion(
  receipt: Record<string, any>,
  displayCurrency: string,
  rateMode: ConversionRateMode,
): boolean {
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
    || (originalCurrency !== displayCurrency && receipt.exchange_rate_source !== rateMode)
    || (originalCurrency !== displayCurrency && (receipt.exchange_rate_source === 'identity' || exchangeRate === 1))
    || (originalTotal !== null && convertedTotal === null)
    || (originalTva !== null && convertedTva === null)
    || exchangeRate === null
    || totalDoesNotMatchRate
    || tvaDoesNotMatchRate;
}

async function ensureReceiptConversion(
  receipt: Record<string, any>,
  displayCurrency: string,
  rateMode: ConversionRateMode,
) {
  if (!needsConversion(receipt, displayCurrency, rateMode)) return receipt;

  const normalized = normalizeReceipt(receipt);
  const conversion = await convertReceiptValues(normalized, displayCurrency, rateMode);
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
  const parsed = parseReceiptDate(receipt.receipt_date) || parseReceiptDate(receipt.date) || parseReceiptDate(receipt.created_at);
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
    const { month, category, status, search, from, to, display_currency, conversion_rate_mode } = req.query as Record<string, string | undefined>;
    const displayCurrency = getDisplayCurrency(display_currency);
    const rateMode = getConversionRateMode(conversion_rate_mode);
    if (!displayCurrency) return res.status(400).json({ error: 'display_currency must be a 3-letter ISO currency code.' });
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
      filteredReceipts.map(receipt => ensureReceiptConversion(receipt, displayCurrency, rateMode)),
    );
    const receipts = convertedReceipts.map(getPublicReceipt);
    debugServer('fetch', {
      fetchedReceiptsCount: receipts.length,
      selectedCurrency: displayCurrency,
      conversionRateMode: rateMode,
      selectedMonth: month || 'all',
      statusCounts: STATUSES.reduce(
        (counts, receiptStatus) => ({
          ...counts,
          [receiptStatus]: receipts.filter(receipt => receipt.status === receiptStatus).length,
        }),
        {},
      ),
    });

    res.json({ receipts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/receipts/export-pdf', async (req, res) => {
  try {
    const {
      month,
      category,
      status,
      search,
      from,
      to,
      display_currency,
      conversion_rate_mode,
      company_name,
      user_name,
    } = req.query as Record<string, string | undefined>;
    const displayCurrency = getDisplayCurrency(display_currency);
    const rateMode = getConversionRateMode(conversion_rate_mode);
    if (!displayCurrency) {
      return res.status(400).json({ error: 'display_currency must be a 3-letter ISO currency code.' });
    }

    let query = getSupabase().from('receipts').select('*').order('receipt_date', { ascending: false });
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
    if (!filteredReceipts.length) {
      return res.status(404).json({ error: 'No receipts match the selected history filters.' });
    }

    const convertedReceipts = await Promise.all(
      filteredReceipts.map(receipt => ensureReceiptConversion(receipt, displayCurrency, rateMode)),
    );
    const receipts = convertedReceipts.map(getPublicReceipt);
    const includedReceipts = receipts.filter(receipt =>
      receipt.display_currency === displayCurrency
      && receipt.exchange_rate_source !== 'failed'
      && receipt.converted_total !== null,
    );
    const excludedCount = receipts.length - includedReceipts.length;
    const total = includedReceipts.reduce((sum, receipt) => sum + Number(receipt.converted_total), 0);
    const totalTva = includedReceipts.reduce((sum, receipt) => sum + Number(receipt.converted_tva || 0), 0);
    const counts = STATUSES.reduce(
      (result, receiptStatus) => ({
        ...result,
        [receiptStatus]: receipts.filter(receipt => receipt.status === receiptStatus).length,
      }),
      {} as Record<string, number>,
    );

    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;
    const contentWidth = pageWidth - margin * 2;
    const bottomMargin = 15;
    const companyName = String(company_name || '').trim().slice(0, 100) || 'ReceiptAI';
    const userName = String(user_name || '').trim().slice(0, 100);
    const periodLabel = month
      ? `Month: ${month}`
      : from || to
        ? `Period: ${from || 'Beginning'} to ${to || 'Today'}`
        : 'Period: All history';
    const activeFilters = [
      category && category !== 'All' ? `Category: ${category}` : null,
      status && status !== 'All' ? `Status: ${status}` : null,
      search ? `Search: ${search}` : null,
    ].filter(Boolean).join('  |  ');
    let y = 0;

    const formatAmount = (value: unknown, currency: string) => {
      const amount = value === null || value === undefined ? null : Number(value);
      if (amount === null || !Number.isFinite(amount)) return 'Unavailable';
      return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
    };

    const drawReportHeader = (continued = false) => {
      doc.setFillColor(17, 24, 39);
      doc.rect(0, 0, pageWidth, continued ? 30 : 43, 'F');
      doc.setFillColor(249, 115, 22);
      doc.rect(0, continued ? 30 : 43, pageWidth, 2, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(continued ? 15 : 20);
      doc.text(doc.splitTextToSize(companyName, 125).slice(0, 1), margin, continued ? 14 : 16);
      doc.setFontSize(continued ? 10 : 12);
      doc.text(continued ? 'RECEIPT HISTORY - CONTINUED' : 'PROFESSIONAL EXPENSE HISTORY', pageWidth - margin, continued ? 14 : 16, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(203, 213, 225);
      if (!continued) {
        if (userName) doc.text(`Prepared by ${userName}`, margin, 24);
        doc.text(`Generated ${new Date().toLocaleString('en-GB')}`, pageWidth - margin, 24, { align: 'right' });
        doc.text(periodLabel, margin, 34);
        if (activeFilters) doc.text(doc.splitTextToSize(activeFilters, 130)[0], pageWidth - margin, 34, { align: 'right' });
      }
      y = continued ? 39 : 52;
    };

    const columnWidths = [24, 68, 31, 35, 52, 59];
    const columnLabels = ['DATE', 'MERCHANT', 'CATEGORY', 'STATUS', 'ORIGINAL', `CONVERTED (${displayCurrency})`];
    const columnX = columnWidths.reduce<number[]>((positions, width, index) => {
      positions.push(index === 0 ? margin : positions[index - 1] + columnWidths[index - 1]);
      return positions;
    }, []);

    const drawTableHeader = () => {
      doc.setFillColor(30, 41, 59);
      doc.rect(margin, y, contentWidth, 10, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(255, 255, 255);
      columnLabels.forEach((label, index) => doc.text(label, columnX[index] + 3, y + 6.5));
      y += 10;
    };

    const addReportPage = () => {
      doc.addPage();
      drawReportHeader(true);
      drawTableHeader();
    };

    drawReportHeader();
    const metricGap = 4;
    const metrics = [
      ['TOTAL', formatAmount(total, displayCurrency)],
      ['TVA', formatAmount(totalTva, displayCurrency)],
      ['RECEIPTS', String(receipts.length)],
      ['APPROVED', String(counts.Approved || 0)],
      ['PENDING', String(counts['Pending Approval'] || 0)],
      ['REJECTED', String(counts.Rejected || 0)],
    ];
    const metricWidth = (contentWidth - metricGap * (metrics.length - 1)) / metrics.length;
    metrics.forEach(([label, value], index) => {
      const x = margin + index * (metricWidth + metricGap);
      doc.setFillColor(248, 250, 252);
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(x, y, metricWidth, 23, 2, 2, 'FD');
      doc.setTextColor(100, 116, 139);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text(label, x + 4, y + 7);
      doc.setTextColor(17, 24, 39);
      doc.setFontSize(11);
      doc.text(doc.splitTextToSize(value, metricWidth - 8)[0], x + 4, y + 16);
    });
    y += 31;

    if (excludedCount) {
      doc.setFillColor(255, 247, 237);
      doc.setDrawColor(251, 146, 60);
      doc.roundedRect(margin, y, contentWidth, 11, 2, 2, 'FD');
      doc.setTextColor(154, 52, 18);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.text(`${excludedCount} receipt${excludedCount === 1 ? '' : 's'} excluded from converted totals because conversion was unavailable.`, margin + 4, y + 7);
      y += 16;
    }

    drawTableHeader();
    receipts.forEach((receipt, index) => {
      const merchantLines = doc.splitTextToSize(receipt.merchant || 'Unknown merchant', columnWidths[1] - 6).slice(0, 2);
      const rowHeight = Math.max(11, merchantLines.length * 4.5 + 4);
      if (y + rowHeight > pageHeight - bottomMargin) addReportPage();

      doc.setFillColor(index % 2 === 0 ? 255 : 248, index % 2 === 0 ? 255 : 250, index % 2 === 0 ? 255 : 252);
      doc.rect(margin, y, contentWidth, rowHeight, 'F');
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, y + rowHeight, pageWidth - margin, y + rowHeight);
      doc.setTextColor(30, 41, 59);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      const originalCurrency = receipt.original_currency || receipt.currency || 'MAD';
      const convertedAmount = receipt.converted_total === null
        ? 'Unavailable'
        : formatAmount(receipt.converted_total, displayCurrency);
      const cells: Array<string | string[]> = [
        receipt.receipt_date || receipt.date || 'N/A',
        merchantLines,
        doc.splitTextToSize(receipt.category || 'Other', columnWidths[2] - 6).slice(0, 2),
        doc.splitTextToSize(receipt.status || 'Pending Approval', columnWidths[3] - 6).slice(0, 2),
        formatAmount(receipt.original_total ?? receipt.total, originalCurrency),
        convertedAmount,
      ];
      cells.forEach((cell, cellIndex) => {
        doc.text(cell, columnX[cellIndex] + 3, y + 6, { lineHeightFactor: 1.15 });
      });
      y += rowHeight;
    });

    const pageCount = doc.getNumberOfPages();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      doc.setPage(pageNumber);
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, pageHeight - 10, pageWidth - margin, pageHeight - 10);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(doc.splitTextToSize(`${companyName} | ReceiptAI`, 170)[0], margin, pageHeight - 5.5);
      doc.text(`Page ${pageNumber} of ${pageCount}`, pageWidth - margin, pageHeight - 5.5, { align: 'right' });
    }

    const filePeriod = month || (from || to ? `${from || 'start'}_${to || 'today'}` : 'all-history');
    const safePeriod = filePeriod.replace(/[^a-zA-Z0-9_-]/g, '-');
    const pdf = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ReceiptAI_History_${safePeriod}.pdf"`);
    res.send(pdf);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/receipts/:id', async (req, res) => {
  try {
    const { data, error } = await getSupabase().from('receipts').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Receipt not found.' });
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

    const displayCurrency = getDisplayCurrency(req.body.display_currency);
    const rateMode = getConversionRateMode(req.body.conversion_rate_mode);
    if (!displayCurrency) return res.status(400).json({ error: 'display_currency must be a 3-letter ISO currency code.' });
    const normalizedReceipt = normalizeReceipt({ ...parsed, status: 'Pending Approval' }, file);
    const duplicates = await findDuplicateReceipts(normalizedReceipt);
    const forceDuplicate = String(req.body.force_duplicate || '').toLowerCase() === 'true';
    if (duplicates.length && !forceDuplicate) {
      return res.status(409).json({
        error: 'This receipt already exists. Do you want to upload anyway?',
        duplicate: true,
        duplicates: duplicates.map(duplicate => getPublicReceipt(duplicate)),
      });
    }

    const conversion = await convertReceiptValues(normalizedReceipt, displayCurrency, rateMode);
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
    const displayCurrency = getDisplayCurrency(req.body.display_currency);
    const rateMode = getConversionRateMode(req.body.conversion_rate_mode);
    if (!displayCurrency) return res.status(400).json({ error: 'display_currency must be a 3-letter ISO currency code.' });
    const { data: receipts, error } = await getSupabase().from('receipts').select('*');
    if (error) return res.status(500).json({ error: error.message });

    const convertedReceipts = [];
    for (const receipt of (receipts || []) as Array<Record<string, any>>) {
      const normalized = normalizeReceipt(receipt);
      const conversion = await convertReceiptValues(normalized, displayCurrency, rateMode);
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
      ? await convertReceiptValues(
          normalized,
          getDisplayCurrency(req.body.display_currency || currentReceipt.display_currency) || 'MAD',
          getConversionRateMode(req.body.conversion_rate_mode),
        )
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

app.delete('/api/receipts/:id/duplicates', async (req, res) => {
  try {
    const { data: keeper, error: keeperError } = await (getSupabase() as any)
      .from('receipts')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (keeperError || !keeper) return res.status(404).json({ error: keeperError?.message || 'Receipt not found.' });

    const duplicates = await findDuplicateReceipts(normalizeReceipt(keeper), req.params.id);
    const duplicateIds = duplicates.map(duplicate => duplicate.id);
    if (!duplicateIds.length) return res.json({ ok: true, deleted: 0 });

    const { error } = await (getSupabase() as any).from('receipts').delete().in('id', duplicateIds);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, deleted: duplicateIds.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/receipts', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? Array.from(new Set(req.body.ids.filter((id: unknown) => typeof id === 'string' && id.trim()).map((id: string) => id.trim())))
      : [];

    if (!ids.length) return res.status(400).json({ error: 'Select at least one receipt to delete.' });
    if (ids.length > 500) return res.status(400).json({ error: 'Delete up to 500 receipts at once.' });

    const { data, error } = await (getSupabase() as any)
      .from('receipts')
      .delete()
      .in('id', ids)
      .select('id');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, deleted: data?.length || 0 });
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
    if (!data) return res.status(404).json({ error: 'Receipt not found.' });
    const storedReceipt = data as unknown as Record<string, any>;

    const { jsPDF } = await import('jspdf');
    const query = req.query as Record<string, string | string[] | undefined>;
    const queryText = (value: string | string[] | undefined, maxLength = 100) =>
      String(Array.isArray(value) ? value[0] : value || '').trim().slice(0, maxLength);
    const requestedCurrency = getDisplayCurrency(
      queryText(query.display_currency, 3) || storedReceipt.display_currency || 'MAD',
    );
    if (!requestedCurrency) {
      return res.status(400).json({ error: 'display_currency must be a 3-letter ISO currency code.' });
    }

    const rateMode = getConversionRateMode(queryText(query.conversion_rate_mode, 20));
    const convertedReceipt = await ensureReceiptConversion(storedReceipt, requestedCurrency, rateMode);
    const receipt = getPublicReceipt(convertedReceipt);
    const companyName = queryText(query.company_name) || 'ReceiptAI';
    const userName = queryText(query.user_name);
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const ref = (receipt.transaction_ref || receipt.id || '').slice(0, 12).toUpperCase();
    const originalCurrency = receipt.original_currency || receipt.currency || 'MAD';
    const displayCurrency = receipt.display_currency || requestedCurrency;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 18;
    const contentWidth = pageWidth - margin * 2;
    const bottomMargin = 19;
    let y = 0;

    const formatAmount = (value: unknown, currency: string) => {
      const amount = value === null || value === undefined ? null : Number(value);
      if (amount === null || !Number.isFinite(amount)) return 'Unavailable';
      return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
    };

    const addPage = () => {
      doc.addPage();
      y = 22;
    };

    const ensureSpace = (height: number) => {
      if (y + height > pageHeight - bottomMargin) addPage();
    };

    const sectionTitle = (title: string) => {
      ensureSpace(14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(249, 115, 22);
      doc.text(title.toUpperCase(), margin, y);
      doc.setDrawColor(229, 231, 235);
      doc.line(margin, y + 3, pageWidth - margin, y + 3);
      doc.setTextColor(17, 24, 39);
      y += 10;
    };

    doc.setFillColor(17, 24, 39);
    doc.rect(0, 0, pageWidth, 53, 'F');
    doc.setFillColor(249, 115, 22);
    doc.rect(0, 53, pageWidth, 2, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(21);
    const companyLines = doc.splitTextToSize(companyName, 112).slice(0, 2);
    doc.text(companyLines, margin, 19);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(203, 213, 225);
    const companyBlockHeight = companyLines.length * 7;
    doc.text('EXPENSE RECEIPT REPORT', margin, 23 + companyBlockHeight);
    if (userName) doc.text(`Prepared by ${userName}`, margin, 30 + companyBlockHeight);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(255, 255, 255);
    doc.text('RECEIPT SUMMARY', pageWidth - margin, 18, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(203, 213, 225);
    doc.text(`Generated ${new Date().toLocaleString('en-GB')}`, pageWidth - margin, 25, { align: 'right' });
    doc.text(`Reference ${ref || 'N/A'}`, pageWidth - margin, 31, { align: 'right' });

    y = 68;
    sectionTitle('Receipt information');
    const merchantLines = doc.splitTextToSize(receipt.merchant || 'Unknown merchant', contentWidth - 16);
    const infoHeight = 27 + merchantLines.length * 6;
    ensureSpace(infoHeight);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(margin, y, contentWidth, infoHeight, 3, 3, 'FD');
    doc.setTextColor(17, 24, 39);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text(merchantLines, margin + 8, y + 10);
    const detailsY = y + 14 + merchantLines.length * 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(71, 85, 105);
    doc.text(`Date: ${receipt.receipt_date || receipt.date || 'N/A'}`, margin + 8, detailsY);
    doc.text(`Category: ${receipt.category || 'Other'}`, margin + 8, detailsY + 7);
    doc.text(`Status: ${receipt.status || 'Pending Approval'}`, margin + contentWidth / 2, detailsY);
    doc.text(`Reference: ${ref || 'N/A'}`, margin + contentWidth / 2, detailsY + 7);
    y += infoHeight + 13;

    sectionTitle('Financial summary');
    const labelWidth = 35;
    const amountWidth = (contentWidth - labelWidth) / 2;
    const rowHeight = 13;
    const tableHeight = rowHeight * 4;
    ensureSpace(tableHeight);
    doc.setFillColor(17, 24, 39);
    doc.roundedRect(margin, y, contentWidth, rowHeight, 2, 2, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('AMOUNT', margin + 5, y + 8);
    doc.text(`ORIGINAL (${originalCurrency})`, margin + labelWidth + 5, y + 8);
    doc.text(`CONVERTED (${displayCurrency})`, margin + labelWidth + amountWidth + 5, y + 8);

    const amountRows = [
      ['HT', receipt.original_ht ?? receipt.ht, receipt.converted_ht],
      ['TVA', receipt.original_tva ?? receipt.tva, receipt.converted_tva],
      ['TOTAL', receipt.original_total ?? receipt.total, receipt.converted_total],
    ] as const;
    amountRows.forEach(([label, original, converted], index) => {
      const rowY = y + rowHeight * (index + 1);
      doc.setFillColor(index === 2 ? 255 : 248, index === 2 ? 247 : 250, index === 2 ? 237 : 252);
      doc.rect(margin, rowY, contentWidth, rowHeight, 'F');
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, rowY, pageWidth - margin, rowY);
      doc.setTextColor(17, 24, 39);
      doc.setFont('helvetica', index === 2 ? 'bold' : 'normal');
      doc.setFontSize(index === 2 ? 10.5 : 9.5);
      doc.text(label, margin + 5, rowY + 8.3);
      doc.text(formatAmount(original, originalCurrency), margin + labelWidth + 5, rowY + 8.3);
      doc.text(formatAmount(converted, displayCurrency), margin + labelWidth + amountWidth + 5, rowY + 8.3);
    });
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(margin, y, contentWidth, tableHeight, 2, 2);
    doc.line(margin + labelWidth, y, margin + labelWidth, y + tableHeight);
    doc.line(margin + labelWidth + amountWidth, y, margin + labelWidth + amountWidth, y + tableHeight);
    y += tableHeight + 9;

    ensureSpace(24);
    doc.setFillColor(receipt.converted_total === null ? 255 : 240, receipt.converted_total === null ? 247 : 253, receipt.converted_total === null ? 237 : 250);
    doc.setDrawColor(receipt.converted_total === null ? 251 : 167, receipt.converted_total === null ? 146 : 243, receipt.converted_total === null ? 60 : 208);
    doc.roundedRect(margin, y, contentWidth, 20, 3, 3, 'FD');
    doc.setTextColor(71, 85, 105);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    const rateLabel = receipt.exchange_rate === null
      ? 'Currency conversion unavailable. Converted values are not included.'
      : `Exchange rate: 1 ${originalCurrency} = ${Number(receipt.exchange_rate).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${displayCurrency}`;
    doc.text(rateLabel, margin + 6, y + 8);
    doc.text(
      `Source: ${receipt.exchange_rate_source || 'N/A'}  |  Rate date: ${receipt.exchange_rate_date || 'N/A'}`,
      margin + 6,
      y + 14,
    );
    y += 31;

    if (receipt.insight) {
      sectionTitle('AI insight');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(51, 65, 85);
      const insightLines = doc.splitTextToSize(String(receipt.insight), contentWidth - 12);
      const lineHeight = 5.5;
      let lineIndex = 0;
      while (lineIndex < insightLines.length) {
        ensureSpace(lineHeight);
        const availableLines = Math.max(1, Math.floor((pageHeight - bottomMargin - y) / lineHeight));
        const pageLines = insightLines.slice(lineIndex, lineIndex + availableLines);
        doc.text(pageLines, margin + 6, y);
        y += pageLines.length * lineHeight;
        lineIndex += pageLines.length;
        if (lineIndex < insightLines.length) addPage();
      }
    }

    const pageCount = doc.getNumberOfPages();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      doc.setPage(pageNumber);
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      const footerName = doc.splitTextToSize(`${companyName} | ReceiptAI`, 120)[0];
      doc.text(footerName, margin, pageHeight - 7);
      doc.text(`Page ${pageNumber} of ${pageCount}`, pageWidth - margin, pageHeight - 7, { align: 'right' });
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
