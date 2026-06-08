import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Check,
  ChevronRight,
  CircleDollarSign,
  Download,
  FileText,
  Filter,
  Home,
  Loader2,
  Pencil,
  PieChart as PieChartIcon,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  DashboardSettings,
  Receipt,
  ReceiptCategory,
  ReceiptFilters,
  ReceiptFormState,
  ReceiptStatus,
} from './types';

const categories: ReceiptCategory[] = ['Meals', 'Transport', 'Software', 'Office', 'Fuel', 'Travel', 'Utilities', 'Other'];
const statuses: ReceiptStatus[] = ['Pending Approval', 'Approved', 'Rejected'];
const dashboardCurrencies = ['MAD', 'EUR', 'USD', 'CHF', 'GBP', 'CAD', 'AED'];
const CUSTOM_CURRENCY = 'CUSTOM';
const chartColors = ['#F97316', '#14B8A6', '#60A5FA', '#A78BFA', '#FACC15', '#FB7185', '#34D399', '#94A3B8'];
const defaultSettings: DashboardSettings = {
  defaultCurrency: 'MAD',
  conversionRateMode: 'latest',
  vatLabel: 'TVA récupérable',
  compactMode: false,
  companyName: '',
  userName: '',
};

type Page = 'dashboard' | 'analytics' | 'settings';

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function isCurrencyCode(value: string) {
  return /^[A-Z]{3}$/.test(value);
}

function debugDashboard(label: string, details: unknown) {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    console.debug(`[ReceiptAI:${label}]`, details);
  }
}

function money(value: number | null | undefined, currency = 'MAD') {
  return `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${currency}`;
}

function numberValue(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasDashboardConversion(receipt: Receipt, displayCurrency: string) {
  return receipt.display_currency === displayCurrency
    && receipt.exchange_rate_source !== 'failed'
    && receipt.converted_total !== null;
}

async function readApiResponse(res: Response) {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }

  const text = await res.text();
  return {
    error: text.trim() || `Request failed with status ${res.status}`,
  };
}

function receiptToForm(receipt: Receipt): ReceiptFormState {
  return {
    merchant: receipt.merchant || '',
    transaction_ref: receipt.transaction_ref || '',
    date: receipt.receipt_date || receipt.date || '',
    category: receipt.category || 'Other',
    total: receipt.original_total === null ? '' : String(receipt.original_total ?? receipt.total ?? ''),
    currency: receipt.original_currency || receipt.currency || 'MAD',
    ht: receipt.original_ht === null ? '' : String(receipt.original_ht ?? receipt.ht ?? ''),
    tva: receipt.original_tva === null ? '' : String(receipt.original_tva ?? receipt.tva ?? ''),
    insight: receipt.insight || '',
    status: receipt.status || 'Pending Approval',
  };
}

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  const [filters, setFilters] = useState<ReceiptFilters>(() => {
    const defaults: ReceiptFilters = {
      month: getCurrentMonth(),
      category: 'All',
      status: 'All',
      search: '',
      from: '',
      to: '',
    };
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem('receiptai-filters') || '{}') };
    } catch {
      return defaults;
    }
  });
  const [settings, setSettings] = useState<DashboardSettings>(() => {
    try {
      const saved = { ...defaultSettings, ...JSON.parse(localStorage.getItem('receiptai-settings') || '{}') };
      return {
        ...saved,
        defaultCurrency: isCurrencyCode(String(saved.defaultCurrency || '').toUpperCase())
          ? String(saved.defaultCurrency).toUpperCase()
          : 'MAD',
        conversionRateMode: saved.conversionRateMode === 'historical' ? 'historical' : 'latest',
      };
    } catch {
      return defaultSettings;
    }
  });
  const [customCurrency, setCustomCurrency] = useState(() =>
    dashboardCurrencies.includes(settings.defaultCurrency) ? '' : settings.defaultCurrency,
  );
  const [currencyMode, setCurrencyMode] = useState(() =>
    dashboardCurrencies.includes(settings.defaultCurrency) ? settings.defaultCurrency : CUSTOM_CURRENCY,
  );
  const [currencyError, setCurrencyError] = useState('');
  const [editForm, setEditForm] = useState<ReceiptFormState | null>(null);
  const [selectedReceiptIds, setSelectedReceiptIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportingHistory, setExportingHistory] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [health, setHealth] = useState('checking');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const receiptRequestRef = useRef(0);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]: [string, string]) => {
      if (value && value !== 'All') params.set(key, value);
    });
    params.set('display_currency', settings.defaultCurrency);
    params.set('conversion_rate_mode', settings.conversionRateMode);
    return params.toString();
  }, [filters, settings.conversionRateMode, settings.defaultCurrency]);

  const fetchReceipts = useCallback(async () => {
    const requestId = ++receiptRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/receipts?${queryString}`);
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to load receipts.');
      if (requestId !== receiptRequestRef.current) return;
      debugDashboard('fetch', {
        fetchedReceiptsCount: data.receipts?.length || 0,
        selectedCurrency: settings.defaultCurrency,
        conversionRateMode: settings.conversionRateMode,
        selectedMonth: filters.month || 'all',
      });
      setReceipts(data.receipts || []);
      setSelectedReceiptIds(current => {
        const availableIds = new Set((data.receipts || []).map((receipt: Receipt) => receipt.id));
        return new Set([...current].filter(id => availableIds.has(id)));
      });
      setSelectedReceipt(current => {
        if (current && data.receipts?.some((receipt: Receipt) => receipt.id === current.id)) {
          return data.receipts.find((receipt: Receipt) => receipt.id === current.id);
        }
        return data.receipts?.[0] || null;
      });
    } catch (err: any) {
      if (requestId !== receiptRequestRef.current) return;
      setError(err.message || 'Network error while loading receipts.');
    } finally {
      if (requestId === receiptRequestRef.current) setLoading(false);
    }
  }, [filters.month, queryString, settings.conversionRateMode, settings.defaultCurrency]);

  useEffect(() => {
    fetchReceipts();
  }, [fetchReceipts]);

  useEffect(() => {
    localStorage.setItem('receiptai-settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem('receiptai-filters', JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    fetch('/api/health')
      .then(readApiResponse)
      .then(data => setHealth(data.supabase === 'ok' ? 'operational' : 'unavailable'))
      .catch(() => setHealth('unavailable'));
  }, []);

  const totals = useMemo(() => {
    const converted = receipts.filter(receipt => hasDashboardConversion(receipt, settings.defaultCurrency));
    const total = converted.reduce((sum, receipt) => sum + Number(receipt.converted_total), 0);
    const tva = converted.reduce((sum, receipt) => sum + Number(receipt.converted_tva || 0), 0);
    const average = converted.length ? total / converted.length : 0;
    const counts = statuses.reduce(
      (acc, status) => ({ ...acc, [status]: receipts.filter(receipt => receipt.status === status).length }),
      {} as Record<ReceiptStatus, number>,
    );
    debugDashboard('totals', {
      selectedCurrency: settings.defaultCurrency,
      conversionRateMode: settings.conversionRateMode,
      selectedMonth: filters.month || 'all',
      totalsCalculationInput: converted.map(receipt => ({
        id: receipt.id,
        converted_total: receipt.converted_total,
        converted_tva: receipt.converted_tva,
      })),
      total,
      tva,
      approved: counts.Approved || 0,
      pending: counts['Pending Approval'] || 0,
      rejected: counts.Rejected || 0,
    });
    return { total, tva, average, counts, excluded: receipts.length - converted.length };
  }, [filters.month, receipts, settings.defaultCurrency]);

  const categoryData = useMemo(() => {
    const grouped = new Map<string, number>();
    receipts
      .filter(receipt => hasDashboardConversion(receipt, settings.defaultCurrency))
      .forEach(receipt => grouped.set(receipt.category || 'Other', (grouped.get(receipt.category || 'Other') || 0) + Number(receipt.converted_total)));
    return Array.from(grouped.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [receipts, settings.defaultCurrency]);

  const monthlyTrend = useMemo(() => {
    const grouped = new Map<string, number>();
    receipts.filter(receipt => hasDashboardConversion(receipt, settings.defaultCurrency)).forEach(receipt => {
      const source = receipt.receipt_date || receipt.date || receipt.created_at;
      const parsed = new Date(source || '');
      const label = Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toISOString().slice(0, 7);
      grouped.set(label, (grouped.get(label) || 0) + Number(receipt.converted_total));
    });
    return Array.from(grouped.entries()).map(([month, total]) => ({ month, total })).sort((a, b) => a.month.localeCompare(b.month));
  }, [receipts, settings.defaultCurrency]);

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setUploading(true);
    setError('');
    setNotice('');
    try {
      const uploadReceipt = async (forceDuplicate = false): Promise<any> => {
        const formData = new FormData();
        formData.append('receipt', file);
        formData.append('display_currency', settings.defaultCurrency);
        formData.append('conversion_rate_mode', settings.conversionRateMode);
        if (forceDuplicate) formData.append('force_duplicate', 'true');

        const res = await fetch('/api/receipts/process', { method: 'POST', body: formData });
        const data = await readApiResponse(res);
        if (res.status === 409 && data.duplicate) {
          const confirmed = window.confirm('This receipt already exists. Do you want to upload anyway?');
          if (!confirmed) return null;
          return uploadReceipt(true);
        }
        if (!res.ok) throw new Error(data.error || 'Failed to process receipt.');
        return data;
      };

      const data = await uploadReceipt();
      if (!data) {
        setNotice('Duplicate upload cancelled. The existing receipt was kept.');
        return;
      }
      setPage('dashboard');
      setSelectedReceipt(data.receipt);
      const receiptMonth = (data.receipt.receipt_date || data.receipt.date || '').slice(0, 7);
      if (receiptMonth && receiptMonth !== filters.month) {
        setFilters(prev => ({ ...prev, month: receiptMonth }));
      } else if (!receiptMonth && filters.month) {
        setFilters(prev => ({ ...prev, month: '' }));
      } else {
        await fetchReceipts();
      }
    } catch (err: any) {
      setError(err.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function updateReceipt(id: string, updates: Partial<ReceiptFormState>) {
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...updates,
        total: updates.total !== undefined ? numberValue(updates.total) : undefined,
        ht: updates.ht !== undefined ? numberValue(updates.ht) : undefined,
        tva: updates.tva !== undefined ? numberValue(updates.tva) : undefined,
        display_currency: settings.defaultCurrency,
        conversion_rate_mode: settings.conversionRateMode,
      };
      const res = await fetch(`/api/receipts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to save receipt.');
      setEditForm(null);
      await fetchReceipts();
    } catch (err: any) {
      setError(err.message || 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(status: ReceiptStatus) {
    if (!selectedReceipt) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/receipts/${selectedReceipt.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to update status.');
      await fetchReceipts();
    } catch (err: any) {
      setError(err.message || 'Status update failed.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteReceipt() {
    if (!selectedReceipt) return;
    const confirmed = window.confirm(`Delete receipt from ${selectedReceipt.merchant || 'Unknown merchant'}?`);
    if (!confirmed) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/receipts/${selectedReceipt.id}`, { method: 'DELETE' });
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to delete receipt.');
      await fetchReceipts();
    } catch (err: any) {
      setError(err.message || 'Delete failed.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteDuplicates() {
    if (!selectedReceipt) return;
    const confirmed = window.confirm(
      `Keep the selected ${selectedReceipt.merchant || 'receipt'} and delete all other matching duplicates?`,
    );
    if (!confirmed) return;

    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch(`/api/receipts/${selectedReceipt.id}/duplicates`, { method: 'DELETE' });
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to delete duplicates.');
      setNotice(data.deleted
        ? `${data.deleted} duplicate receipt${data.deleted === 1 ? '' : 's'} deleted. The selected receipt was kept.`
        : 'No matching duplicates were found.');
      await fetchReceipts();
    } catch (err: any) {
      setError(err.message || 'Duplicate cleanup failed.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelectedReceipts() {
    const ids = [...selectedReceiptIds];
    if (!ids.length) return;
    const confirmed = window.confirm(
      `Permanently delete ${ids.length} selected receipt${ids.length === 1 ? '' : 's'}? This cannot be undone.`,
    );
    if (!confirmed) return;

    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/receipts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to delete selected receipts.');
      setSelectedReceiptIds(new Set());
      setNotice(`${data.deleted || ids.length} receipt${(data.deleted || ids.length) === 1 ? '' : 's'} permanently deleted.`);
      await fetchReceipts();
    } catch (err: any) {
      setError(err.message || 'Bulk delete failed.');
    } finally {
      setSaving(false);
    }
  }

  async function exportPdf() {
    if (!selectedReceipt) return;
    setError('');
    try {
      const params = new URLSearchParams({
        display_currency: settings.defaultCurrency,
        conversion_rate_mode: settings.conversionRateMode,
      });
      if (settings.companyName.trim()) params.set('company_name', settings.companyName.trim());
      if (settings.userName.trim()) params.set('user_name', settings.userName.trim());
      const res = await fetch(`/api/receipts/${selectedReceipt.id}/export-pdf?${params}`);
      if (!res.ok) {
        const data = await readApiResponse(res);
        throw new Error(data.error || 'PDF export failed.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ReceiptAI_${(selectedReceipt.transaction_ref || selectedReceipt.id).slice(0, 12)}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || 'PDF export failed.');
    }
  }

  async function exportHistoryPdf() {
    setError('');
    setExportingHistory(true);
    try {
      const params = new URLSearchParams(queryString);
      if (settings.companyName.trim()) params.set('company_name', settings.companyName.trim());
      if (settings.userName.trim()) params.set('user_name', settings.userName.trim());
      const res = await fetch(`/api/receipts/export-pdf?${params}`);
      if (!res.ok) {
        const data = await readApiResponse(res);
        throw new Error(data.error || 'History PDF export failed.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const period = filters.month || (filters.from || filters.to ? `${filters.from || 'start'}_${filters.to || 'today'}` : 'all-history');
      link.href = url;
      link.download = `ReceiptAI_History_${period}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || 'History PDF export failed.');
    } finally {
      setExportingHistory(false);
    }
  }

  const navItems = [
    { page: 'dashboard' as const, label: 'Dashboard', icon: Home },
    { page: 'analytics' as const, label: 'Analytics', icon: BarChart3 },
    { page: 'settings' as const, label: 'Settings', icon: Settings },
  ];

  const currencySelectValue = currencyMode;

  function selectCurrency(value: string) {
    setCurrencyMode(value);
    if (value === CUSTOM_CURRENCY) {
      setCustomCurrency(dashboardCurrencies.includes(settings.defaultCurrency) ? '' : settings.defaultCurrency);
      setCurrencyError('');
      return;
    }
    setCurrencyError('');
    setCustomCurrency('');
    setSettings(prev => ({ ...prev, defaultCurrency: value }));
  }

  function applyCustomCurrency(value: string) {
    const currency = value.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase();
    setCustomCurrency(currency);
    if (currency.length === 3) {
      setCurrencyError('');
      setCurrencyMode(CUSTOM_CURRENCY);
      setSettings(prev => ({ ...prev, defaultCurrency: currency }));
    } else {
      setCurrencyError('Enter exactly 3 letters.');
    }
  }

  return (
    <div className="min-h-screen bg-[#080808] text-slate-100">
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,application/pdf" className="hidden" onChange={handleUpload} />

      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 border-r border-white/10 bg-black/50 p-5 backdrop-blur-xl lg:block">
        <div className="flex items-center gap-3 px-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-orange-500 text-black shadow-lg shadow-orange-500/20">
            <FileText size={24} />
          </div>
          <div>
            <h1 className="text-xl font-bold">Receipt<span className="text-orange-500">AI</span></h1>
            <p className="text-xs text-slate-500">Smart expense operations</p>
          </div>
        </div>

        <nav className="mt-10 space-y-2">
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.page}
                onClick={() => setPage(item.page)}
                className={`flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition ${
                  page === item.page ? 'bg-orange-500 text-black' : 'text-slate-400 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="mt-8 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-sm font-bold text-black transition hover:bg-orange-100 disabled:opacity-60"
        >
          {uploading ? <Loader2 className="animate-spin" size={18} /> : <Upload size={18} />}
          Upload receipt
        </button>

        <div className="absolute bottom-5 left-5 right-5 rounded-lg border border-white/10 bg-white/[0.04] p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">System status</p>
          <p className={`mt-1 text-sm font-medium ${health === 'operational' ? 'text-emerald-400' : 'text-amber-300'}`}>
            {health === 'operational' ? 'Operational' : health === 'checking' ? 'Checking...' : 'Unavailable'}
          </p>
        </div>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-10 border-b border-white/10 bg-[#080808]/90 px-3 py-3 backdrop-blur-xl sm:px-4 md:px-8 md:py-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-black lg:hidden">
                <FileText size={19} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[10px] uppercase tracking-[0.2em] text-orange-400 sm:text-xs sm:tracking-[0.24em]">Global expense management</p>
                <h2 className="mt-0.5 truncate text-xl font-semibold sm:text-2xl md:text-3xl">
                  {page === 'dashboard' ? 'Receipt control center' : page === 'analytics' ? 'Expense analytics' : 'Workspace settings'}
                </h2>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
              <label className="flex h-9 min-w-0 items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-xs text-slate-300 sm:h-10 sm:justify-start sm:text-sm">
                <span className="hidden sm:inline">Currency</span>
                <select
                  value={currencySelectValue}
                  onChange={event => selectCurrency(event.target.value)}
                  className="min-w-0 bg-transparent font-semibold text-white outline-none"
                  aria-label="Dashboard currency"
                >
                  {dashboardCurrencies.map(currency => <option key={currency} value={currency} className="bg-neutral-900">{currency}</option>)}
                  <option value={CUSTOM_CURRENCY} className="bg-neutral-900">Other / Custom</option>
                </select>
              </label>
              {currencySelectValue === CUSTOM_CURRENCY && (
                <input
                  value={customCurrency}
                  onChange={event => applyCustomCurrency(event.target.value)}
                  placeholder="Enter currency code"
                  maxLength={3}
                  aria-label="Custom currency code"
                  className="col-span-2 h-9 w-full rounded-lg border border-white/10 bg-white/5 px-3 text-xs uppercase outline-none focus:border-orange-500 sm:h-10 sm:w-44 sm:text-sm"
                />
              )}
              <span className="flex h-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 px-2 text-center text-[11px] text-slate-400 sm:h-10 sm:px-3 sm:text-xs">
                {settings.conversionRateMode === 'latest' ? 'Latest rates' : 'Historical rates'}
              </span>
              <button
                onClick={fetchReceipts}
                disabled={loading}
                className="hidden h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-slate-200 transition hover:bg-white/10 disabled:opacity-60 sm:flex"
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                Refresh
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="hidden h-10 items-center gap-2 rounded-lg bg-orange-500 px-4 text-sm font-bold text-black transition hover:bg-orange-400 disabled:opacity-60 sm:flex"
              >
                {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                Upload
              </button>
            </div>
          </div>
        </header>

        <main className={`px-3 py-4 pb-28 sm:px-4 sm:py-6 md:px-8 lg:pb-6 ${settings.compactMode ? 'space-y-4' : 'space-y-5 md:space-y-6'}`}>
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
              <X size={18} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">{notice}</div>
          )}
          {currencyError && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">{currencyError}</div>
          )}
          {totals.excluded > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
              {totals.excluded} receipt{totals.excluded === 1 ? '' : 's'} excluded from totals because conversion to {settings.defaultCurrency} is unavailable or pending.
            </div>
          )}

          {page === 'dashboard' && (
            <>
              <section className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-[1.5fr_1fr_1fr_1fr]">
                <Kpi title="Monthly Total" value={loading && !receipts.length ? 'Loading...' : money(totals.total, settings.defaultCurrency)} icon={CircleDollarSign} />
                <Kpi title={settings.vatLabel} value={loading && !receipts.length ? 'Loading...' : money(totals.tva, settings.defaultCurrency)} icon={FileText} />
                <Kpi title="Pending" value={loading && !receipts.length ? '...' : String(totals.counts['Pending Approval'] || 0)} icon={SlidersHorizontal} />
                <Kpi title="Approved" value={loading && !receipts.length ? '...' : String(totals.counts.Approved || 0)} icon={Check} />
              </section>

              <FilterBar
                filters={filters}
                setFilters={setFilters}
                onExport={exportHistoryPdf}
                exporting={exportingHistory}
                receiptCount={receipts.length}
              />

              <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_390px]">
                <div className="space-y-6">
                  <UploadZone uploading={uploading} onPick={() => fileInputRef.current?.click()} />
                  <ReceiptTable
                    receipts={receipts}
                    selectedId={selectedReceipt?.id}
                    selectedReceiptIds={selectedReceiptIds}
                    loading={loading}
                    saving={saving}
                    currency={settings.defaultCurrency}
                    month={filters.month}
                    onSelect={receipt => {
                      setSelectedReceipt(receipt);
                      setEditForm(null);
                    }}
                    onToggleSelected={id => {
                      setSelectedReceiptIds(current => {
                        const next = new Set(current);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      });
                    }}
                    onSelectAllVisible={() => {
                      setSelectedReceiptIds(current => {
                        const visibleIds = receipts.map(receipt => receipt.id);
                        const allVisibleSelected = visibleIds.every(id => current.has(id));
                        if (allVisibleSelected) {
                          return new Set([...current].filter(id => !visibleIds.includes(id)));
                        }
                        return new Set([...current, ...visibleIds]);
                      });
                    }}
                    onDeleteSelected={deleteSelectedReceipts}
                  />
                </div>

                <DetailsPanel
                  receipt={selectedReceipt}
                  editForm={editForm}
                  setEditForm={setEditForm}
                  onApprove={() => updateStatus('Approved')}
                  onReject={() => updateStatus('Rejected')}
                  onPending={() => updateStatus('Pending Approval')}
                  onDelete={deleteReceipt}
                  onDeleteDuplicates={deleteDuplicates}
                  onExport={exportPdf}
                  onSave={() => selectedReceipt && editForm && updateReceipt(selectedReceipt.id, editForm)}
                  setForm={setEditForm}
                  saving={saving}
                  displayCurrency={settings.defaultCurrency}
                />
              </section>

              <section className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <ChartCard title="Spending by Category" empty={!categoryData.length}>
                  <ResponsiveContainer width="100%" height={270}>
                    <PieChart>
                      <Pie data={categoryData} innerRadius={70} outerRadius={100} dataKey="value" paddingAngle={4}>
                        {categoryData.map((entry, index) => <Cell key={entry.name} fill={chartColors[index % chartColors.length]} />)}
                      </Pie>
                      <Tooltip formatter={(value: number) => money(value, settings.defaultCurrency)} contentStyle={tooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Recent Category Totals" empty={!categoryData.length}>
                  <ResponsiveContainer width="100%" height={270}>
                    <BarChart data={categoryData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                      <XAxis dataKey="name" stroke="#94A3B8" fontSize={12} />
                      <YAxis stroke="#94A3B8" fontSize={12} />
                      <Tooltip formatter={(value: number) => money(value, settings.defaultCurrency)} contentStyle={tooltipStyle} />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="#F97316" />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </section>
            </>
          )}

          {page === 'analytics' && (
            <section className="space-y-6">
              <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
                <Kpi title="Total expenses" value={loading && !receipts.length ? 'Loading...' : money(totals.total, settings.defaultCurrency)} icon={CircleDollarSign} />
                <Kpi title="TVA total" value={loading && !receipts.length ? 'Loading...' : money(totals.tva, settings.defaultCurrency)} icon={FileText} />
                <Kpi title="Average receipt" value={loading && !receipts.length ? 'Loading...' : money(totals.average, settings.defaultCurrency)} icon={PieChartIcon} />
                <Kpi title="Receipts" value={loading && !receipts.length ? '...' : String(receipts.length)} icon={FileText} />
              </div>
              <ChartCard title="Monthly Trend" empty={!monthlyTrend.length}>
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={monthlyTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                    <XAxis dataKey="month" stroke="#94A3B8" fontSize={12} />
                    <YAxis stroke="#94A3B8" fontSize={12} />
                    <Tooltip formatter={(value: number) => money(value, settings.defaultCurrency)} contentStyle={tooltipStyle} />
                    <Area type="monotone" dataKey="total" stroke="#F97316" fill="#F97316" fillOpacity={0.22} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
              <ChartCard title="Category Breakdown" empty={!categoryData.length}>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={categoryData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                    <XAxis type="number" stroke="#94A3B8" fontSize={12} />
                    <YAxis type="category" dataKey="name" stroke="#94A3B8" width={90} fontSize={12} />
                    <Tooltip formatter={(value: number) => money(value, settings.defaultCurrency)} contentStyle={tooltipStyle} />
                    <Bar dataKey="value" radius={[0, 6, 6, 0]} fill="#14B8A6" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </section>
          )}

          {page === 'settings' && (
            <section className="max-w-3xl rounded-lg border border-white/10 bg-white/[0.05] p-4 shadow-2xl shadow-black/20 backdrop-blur sm:p-6">
              <h3 className="text-lg font-semibold">Dashboard preferences</h3>
              <div className="mt-6 grid gap-5">
                <div className="grid gap-4 rounded-lg border border-white/10 bg-black/20 p-4 md:grid-cols-2">
                  <label className="grid gap-2 text-sm">
                    <span className="text-slate-400">Company name for PDF</span>
                    <input
                      value={settings.companyName}
                      onChange={event => setSettings(prev => ({ ...prev, companyName: event.target.value }))}
                      placeholder="Your company"
                      maxLength={100}
                      className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 outline-none focus:border-orange-500"
                    />
                  </label>
                  <label className="grid gap-2 text-sm">
                    <span className="text-slate-400">Prepared by / user name</span>
                    <input
                      value={settings.userName}
                      onChange={event => setSettings(prev => ({ ...prev, userName: event.target.value }))}
                      placeholder="Your full name"
                      maxLength={100}
                      className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 outline-none focus:border-orange-500"
                    />
                  </label>
                  <p className="text-xs text-slate-500 md:col-span-2">
                    These details are saved on this device and printed in the professional PDF header.
                  </p>
                </div>
                <label className="grid gap-2 text-sm">
                  <span className="text-slate-400">Default currency</span>
                  <select
                    value={currencySelectValue}
                    onChange={event => selectCurrency(event.target.value)}
                    className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 outline-none focus:border-orange-500"
                  >
                    {dashboardCurrencies.map(currency => <option key={currency}>{currency}</option>)}
                    <option value={CUSTOM_CURRENCY}>Other / Custom</option>
                  </select>
                  {currencySelectValue === CUSTOM_CURRENCY && (
                    <input
                      value={customCurrency}
                      onChange={event => applyCustomCurrency(event.target.value)}
                      placeholder="Enter currency code"
                      maxLength={3}
                      className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 uppercase outline-none focus:border-orange-500"
                    />
                  )}
                  {currencyError && <span className="text-xs text-amber-300">{currencyError}</span>}
                </label>
                <label className="grid gap-2 text-sm">
                  <span className="text-slate-400">VAT label</span>
                  <input
                    value={settings.vatLabel}
                    onChange={event => setSettings(prev => ({ ...prev, vatLabel: event.target.value }))}
                    className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 outline-none focus:border-orange-500"
                  />
                </label>
                <label className="grid gap-2 text-sm">
                  <span className="text-slate-400">Conversion rate mode</span>
                  <select
                    value={settings.conversionRateMode}
                    onChange={event => setSettings(prev => ({
                      ...prev,
                      conversionRateMode: event.target.value as DashboardSettings['conversionRateMode'],
                    }))}
                    className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 outline-none focus:border-orange-500"
                  >
                    <option value="latest">Latest rate (default)</option>
                    <option value="historical">Historical receipt date rate</option>
                  </select>
                  <span className="text-xs text-slate-500">
                    {settings.conversionRateMode === 'latest'
                      ? 'Uses the latest published rate and ignores receipt dates.'
                      : 'Uses each receipt date. Receipts without an available dated rate are excluded.'}
                  </span>
                </label>
                <label className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 p-4 text-sm">
                  <span>
                    <span className="block font-medium">Compact dashboard</span>
                    <span className="text-slate-500">Reduce vertical spacing for dense accounting work.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.compactMode}
                    onChange={event => setSettings(prev => ({ ...prev, compactMode: event.target.checked }))}
                    className="h-5 w-5 accent-orange-500"
                  />
                </label>
              </div>
            </section>
          )}
        </main>
      </div>

      <footer className="fixed bottom-0 left-0 right-0 z-30 border-t border-white/10 bg-[#0c0c0c]/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl lg:hidden">
        <nav className="mx-auto grid max-w-md grid-cols-4 gap-1">
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.page}
                onClick={() => setPage(item.page)}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10px] font-medium transition ${
                  page === item.page ? 'bg-orange-500/15 text-orange-400' : 'text-slate-500'
                }`}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg bg-orange-500 text-[10px] font-bold text-black shadow-lg shadow-orange-500/20 disabled:opacity-60"
          >
            {uploading ? <Loader2 size={19} className="animate-spin" /> : <Upload size={19} />}
            <span>Upload</span>
          </button>
        </nav>
      </footer>
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: '#111',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: '8px',
  color: '#fff',
};

function Kpi({ title, value, icon: Icon }: { title: string; value: string; icon: React.ElementType }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.05] p-3.5 shadow-2xl shadow-black/20 backdrop-blur sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-slate-500">{title}</p>
        <Icon size={18} className="text-orange-400" />
      </div>
      <p className="mt-2 break-words text-lg font-semibold leading-tight text-white sm:mt-3 sm:text-2xl">{value}</p>
    </div>
  );
}

function FilterBar({
  filters,
  setFilters,
  onExport,
  exporting,
  receiptCount,
}: {
  filters: ReceiptFilters;
  setFilters: React.Dispatch<React.SetStateAction<ReceiptFilters>>;
  onExport: () => void;
  exporting: boolean;
  receiptCount: number;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.04] p-3 backdrop-blur sm:p-4">
      <div className="mb-3 flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Filter size={17} className="text-orange-400" />
          Receipt history
        </div>
        <div className="flex items-center justify-between gap-2 sm:justify-start sm:gap-3">
          <p className="text-xs text-slate-500">{filters.month ? `Showing ${filters.month}` : 'Showing all months'}</p>
          <button
            onClick={onExport}
            disabled={exporting || receiptCount === 0}
            className="flex h-9 items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-2.5 text-[11px] font-semibold text-orange-200 transition hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:px-3 sm:text-xs"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {exporting ? 'Preparing PDF...' : 'Export history PDF'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
        <label className="relative xl:col-span-2">
          <Search className="absolute left-3 top-3 text-slate-500" size={16} />
          <input
            value={filters.search}
            onChange={event => setFilters(prev => ({ ...prev, search: event.target.value }))}
            placeholder="Search merchant, status, category"
            className="h-10 w-full rounded-lg border border-white/10 bg-black/30 pl-9 pr-3 text-sm outline-none focus:border-orange-500"
          />
        </label>
        <label className="grid gap-1 text-xs text-slate-500">
          Month
          <input
            type="month"
            value={filters.month}
            onChange={event => setFilters(prev => ({ ...prev, month: event.target.value }))}
            className="h-10 rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-slate-100 outline-none focus:border-orange-500"
          />
        </label>
        <select
          value={filters.category}
          onChange={event => setFilters(prev => ({ ...prev, category: event.target.value as ReceiptFilters['category'] }))}
          className="h-10 rounded-lg border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-orange-500"
        >
          <option>All</option>
          {categories.map(category => <option key={category}>{category}</option>)}
        </select>
        <select
          value={filters.status}
          onChange={event => setFilters(prev => ({ ...prev, status: event.target.value as ReceiptFilters['status'] }))}
          className="h-10 rounded-lg border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-orange-500"
        >
          <option>All</option>
          {statuses.map(status => <option key={status}>{status}</option>)}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setFilters(prev => ({ ...prev, month: '' }))}
            className="h-10 rounded-lg border border-white/10 bg-white/5 px-3 text-sm transition hover:bg-white/10"
          >
            All history
          </button>
          <button
            onClick={() => setFilters({ month: getCurrentMonth(), category: 'All', status: 'All', search: '', from: '', to: '' })}
            className="h-10 rounded-lg border border-white/10 bg-white/5 px-3 text-sm transition hover:bg-white/10"
          >
            Reset
          </button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <input
          type="date"
          value={filters.from}
          onChange={event => setFilters(prev => ({ ...prev, from: event.target.value }))}
          className="h-10 rounded-lg border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-orange-500"
        />
        <input
          type="date"
          value={filters.to}
          onChange={event => setFilters(prev => ({ ...prev, to: event.target.value }))}
          className="h-10 rounded-lg border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-orange-500"
        />
      </div>
    </section>
  );
}

function UploadZone({ uploading, onPick }: { uploading: boolean; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      disabled={uploading}
      className="group flex min-h-36 w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-white/10 bg-white/[0.03] p-5 text-center transition hover:border-orange-500/70 hover:bg-orange-500/5 disabled:opacity-70 sm:min-h-44 sm:p-8"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-orange-500/15 text-orange-400 transition group-hover:scale-105">
        {uploading ? <Loader2 className="animate-spin" size={26} /> : <Upload size={26} />}
      </div>
      <p className="mt-3 text-base font-semibold sm:mt-4 sm:text-lg">{uploading ? 'Extracting receipt data...' : 'Upload JPG, PNG, or PDF receipt'}</p>
      <p className="mt-1 text-sm text-slate-500">ReceiptAI securely extracts printed values and converts them using dated exchange rates.</p>
    </button>
  );
}

function ReceiptTable({
  receipts,
  selectedId,
  selectedReceiptIds,
  loading,
  saving,
  currency,
  month,
  onSelect,
  onToggleSelected,
  onSelectAllVisible,
  onDeleteSelected,
}: {
  receipts: Receipt[];
  selectedId?: string;
  selectedReceiptIds: Set<string>;
  loading: boolean;
  saving: boolean;
  currency: string;
  month: string;
  onSelect: (receipt: Receipt) => void;
  onToggleSelected: (id: string) => void;
  onSelectAllVisible: () => void;
  onDeleteSelected: () => void;
}) {
  if (loading && !receipts.length) {
    return (
      <div className="flex min-h-72 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
        <Loader2 className="animate-spin text-orange-400" />
      </div>
    );
  }

  if (!receipts.length) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] p-8 text-center">
        <FileText size={34} className="text-slate-500" />
        <p className="mt-3 text-lg font-semibold">No receipts found{month ? ` for ${month}` : ''}</p>
        <p className="mt-1 max-w-md text-sm text-slate-500">
          {month ? 'Choose another month or select All history. Existing receipts remain stored securely.' : 'Upload a receipt or adjust the history filters.'}
        </p>
      </div>
    );
  }

  const selectedCount = selectedReceiptIds.size;
  const allVisibleSelected = receipts.length > 0 && receipts.every(receipt => selectedReceiptIds.has(receipt.id));

  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]">
      <div className="flex flex-col gap-3 border-b border-white/10 bg-black/20 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <label className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-xs font-semibold text-slate-200">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={onSelectAllVisible}
            className="h-5 w-5 rounded border-white/20 bg-black/40 accent-orange-500"
          />
          Select all visible
        </label>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <span className="text-xs text-slate-500">
            {selectedCount ? `${selectedCount} selected` : `${receipts.length} in history`}
          </span>
          <button
            onClick={onDeleteSelected}
            disabled={saving || selectedCount === 0}
            className="flex h-9 items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 text-xs font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete selected
          </button>
        </div>
      </div>
      {loading && (
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-xs text-slate-400">
          <Loader2 size={13} className="animate-spin" />
          Refreshing history...
        </div>
      )}
      <div className="hidden grid-cols-[88px_1.2fr_0.8fr_0.7fr_0.7fr_32px] gap-3 border-b border-white/10 px-4 py-3 text-xs uppercase tracking-wide text-slate-500 sm:grid">
        <span>Select</span>
        <span>Merchant</span>
        <span>Category</span>
        <span>Status</span>
        <span className="text-right">Total</span>
        <span />
      </div>
      {receipts.map(receipt => {
        const isChecked = selectedReceiptIds.has(receipt.id);
        return (
          <div
            key={receipt.id}
            className={`grid w-full grid-cols-[92px_1fr_auto] items-start gap-x-3 gap-y-3 border-b border-white/5 px-3 py-3.5 text-left text-sm transition last:border-0 sm:grid-cols-[88px_1.2fr_0.8fr_0.7fr_0.7fr_32px] sm:items-center sm:gap-3 sm:px-4 sm:py-4 ${
              isChecked ? 'bg-orange-500/15' : selectedId === receipt.id ? 'bg-orange-500/10' : 'hover:bg-white/[0.06]'
            }`}
          >
            <button
              type="button"
              onClick={() => onToggleSelected(receipt.id)}
              aria-pressed={isChecked}
              className={`col-start-1 row-span-3 flex h-10 items-center justify-center rounded-lg border px-2 text-[11px] font-bold transition sm:row-auto ${
                isChecked
                  ? 'border-orange-500 bg-orange-500 text-black'
                  : 'border-white/15 bg-white/5 text-slate-300 hover:border-orange-500/70 hover:text-orange-300'
              }`}
              aria-label={`${isChecked ? 'Unselect' : 'Select'} ${receipt.merchant || 'receipt'}`}
            >
              {isChecked ? 'Selected' : 'Select'}
            </button>
            <button type="button" onClick={() => onSelect(receipt)} className="col-start-2 min-w-0 text-left">
              <span className="block truncate font-medium">{receipt.merchant || 'Unknown merchant'}</span>
              <span className="block truncate text-xs text-slate-500">{receipt.date || receipt.created_at?.slice(0, 10)} • {receipt.transaction_ref || receipt.id.slice(0, 8)}</span>
            </button>
            <button type="button" onClick={() => onSelect(receipt)} className="col-start-2 row-start-2 truncate text-left text-xs text-slate-400 sm:col-auto sm:row-auto sm:text-sm sm:text-slate-300">{receipt.category}</button>
            <button type="button" onClick={() => onSelect(receipt)} className="col-start-3 row-start-1 justify-self-end sm:col-auto sm:row-auto sm:justify-self-auto"><StatusPill status={receipt.status} /></button>
            <button type="button" onClick={() => onSelect(receipt)} className="col-span-2 col-start-2 row-start-3 text-left sm:col-auto sm:row-auto sm:text-right">
              <span className="block font-semibold">Original: {money(receipt.original_total ?? receipt.total, receipt.original_currency || receipt.currency || 'MAD')}</span>
              {receipt.converted_total !== null && receipt.display_currency === currency ? (
                <span className="block text-xs text-emerald-300">Converted: {money(receipt.converted_total, receipt.display_currency)}</span>
              ) : (
                <span className="block text-xs text-amber-300">Conversion unavailable</span>
              )}
            </button>
            <button type="button" onClick={() => onSelect(receipt)} className="hidden text-slate-500 sm:block">
              <ChevronRight size={17} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function DetailsPanel({
  receipt,
  editForm,
  setEditForm,
  onApprove,
  onReject,
  onPending,
  onDelete,
  onDeleteDuplicates,
  onExport,
  onSave,
  setForm,
  saving,
  displayCurrency,
}: {
  receipt: Receipt | null;
  editForm: ReceiptFormState | null;
  setEditForm: (form: ReceiptFormState | null) => void;
  onApprove: () => void;
  onReject: () => void;
  onPending: () => void;
  onDelete: () => void;
  onDeleteDuplicates: () => void;
  onExport: () => void;
  onSave: () => void;
  setForm: React.Dispatch<React.SetStateAction<ReceiptFormState | null>>;
  saving: boolean;
  displayCurrency: string;
}) {
  if (!receipt) {
    return (
      <aside className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] p-6 text-center sm:min-h-[520px] sm:p-8">
        <FileText size={34} className="text-slate-500" />
        <p className="mt-3 text-lg font-semibold">Select a receipt</p>
        <p className="mt-1 text-sm text-slate-500">Receipt details, approval workflow, edits, and PDF export will appear here.</p>
      </aside>
    );
  }

  const form = editForm;
  return (
    <aside className="rounded-lg border border-white/10 bg-white/[0.05] p-4 shadow-2xl shadow-black/20 backdrop-blur sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <StatusPill status={receipt.status} />
          <h3 className="mt-3 truncate text-xl font-semibold sm:text-2xl">{receipt.merchant || 'Unknown merchant'}</h3>
          <p className="mt-1 text-sm text-slate-500">{receipt.date || 'No date'} • {receipt.transaction_ref || receipt.id.slice(0, 8)}</p>
        </div>
        <button onClick={() => setEditForm(form ? null : receiptToForm(receipt))} className="rounded-lg border border-white/10 bg-white/5 p-2 transition hover:bg-white/10">
          <Pencil size={17} />
        </button>
      </div>

      {form ? (
        <div className="mt-5 grid gap-3">
          <Field label="Merchant" value={form.merchant} onChange={value => setForm(prev => prev && { ...prev, merchant: value })} />
          <Field label="Transaction Ref" value={form.transaction_ref} onChange={value => setForm(prev => prev && { ...prev, transaction_ref: value })} />
          <Field label="Date" value={form.date} onChange={value => setForm(prev => prev && { ...prev, date: value })} />
          <select value={form.category} onChange={event => setForm(prev => prev && { ...prev, category: event.target.value as ReceiptCategory })} className="h-10 rounded-lg border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-orange-500">
            {categories.map(category => <option key={category}>{category}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Total" value={form.total} onChange={value => setForm(prev => prev && { ...prev, total: value })} />
            <Field label="Currency" value={form.currency} onChange={value => setForm(prev => prev && { ...prev, currency: value.toUpperCase() })} />
            <Field label="HT" value={form.ht} onChange={value => setForm(prev => prev && { ...prev, ht: value })} />
            <Field label="TVA" value={form.tva} onChange={value => setForm(prev => prev && { ...prev, tva: value })} />
          </div>
          <textarea
            value={form.insight}
            onChange={event => setForm(prev => prev && { ...prev, insight: event.target.value })}
            rows={4}
            className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setEditForm(null)} className="h-10 rounded-lg border border-white/10 bg-white/5 text-sm transition hover:bg-white/10">Cancel</button>
            <button onClick={onSave} disabled={saving} className="h-10 rounded-lg bg-orange-500 text-sm font-bold text-black transition hover:bg-orange-400 disabled:opacity-60">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Detail label="Category" value={receipt.category} />
            <Detail label="Original currency" value={receipt.original_currency || receipt.currency || 'MAD'} />
            <Detail label="Montant HT" value={money(receipt.original_ht ?? receipt.ht, receipt.original_currency || receipt.currency || 'MAD')} />
            <Detail label="TVA" value={money(receipt.original_tva ?? receipt.tva, receipt.original_currency || receipt.currency || 'MAD')} />
            <Detail
              label="Converted HT"
              value={receipt.display_currency !== displayCurrency
                ? `Updating to ${displayCurrency}...`
                : receipt.converted_ht === null ? 'Unavailable' : money(receipt.converted_ht, receipt.display_currency)}
            />
            <Detail
              label="Converted TVA"
              value={receipt.display_currency !== displayCurrency
                ? `Updating to ${displayCurrency}...`
                : receipt.converted_tva === null ? 'Unavailable' : money(receipt.converted_tva, receipt.display_currency)}
            />
            <Detail
              label="Exchange rate"
              value={receipt.exchange_rate
                ? `${receipt.exchange_rate} (${receipt.exchange_rate_source}, ${receipt.exchange_rate_date || 'no date'})`
                : 'Unavailable'}
            />
          </div>
          <div className="mt-5 rounded-lg border border-orange-500/20 bg-orange-500/10 p-4">
            <p className="text-xs uppercase tracking-wide text-orange-300">Original total</p>
            <p className="mt-1 break-words text-2xl font-bold sm:text-3xl">{money(receipt.original_total ?? receipt.total, receipt.original_currency || receipt.currency || 'MAD')}</p>
            {receipt.converted_total !== null && receipt.display_currency === displayCurrency ? (
              <p className="mt-2 text-sm text-emerald-300">Converted: {money(receipt.converted_total, receipt.display_currency || 'MAD')}</p>
            ) : (
              <p className="mt-2 text-sm text-amber-300">
                {receipt.display_currency !== displayCurrency
                  ? `Updating conversion to ${displayCurrency}...`
                  : receipt.conversion_warning || 'Conversion unavailable. This receipt is excluded from dashboard totals.'}
              </p>
            )}
          </div>
          {receipt.insight && (
            <div className="mt-4 rounded-lg border border-white/10 bg-black/25 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">AI insight</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">{receipt.insight}</p>
            </div>
          )}
          <div className="mt-5 grid grid-cols-3 gap-1.5 sm:gap-2">
            <button onClick={onApprove} disabled={saving} className="rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-emerald-300 transition hover:bg-emerald-500/25">Approve</button>
            <button onClick={onReject} disabled={saving} className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300 transition hover:bg-red-500/25">Reject</button>
            <button onClick={onPending} disabled={saving} className="rounded-lg bg-sky-500/15 px-3 py-2 text-sm text-sky-300 transition hover:bg-sky-500/25">Pending</button>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button onClick={onExport} className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm transition hover:bg-white/10">
              <Download size={16} />
              Export PDF
            </button>
            <button onClick={onDeleteDuplicates} disabled={saving} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-60">
              Delete duplicates
            </button>
            <button onClick={onDelete} disabled={saving} className="flex items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300 transition hover:bg-red-500/20">
              <Trash2 size={16} />
              Delete
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1 text-xs text-slate-500">
      {label}
      <input value={value} onChange={event => onChange(event.target.value)} className="h-10 rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-slate-100 outline-none focus:border-orange-500" />
    </label>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 break-words text-sm font-medium">{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: ReceiptStatus }) {
  const styles: Record<ReceiptStatus, string> = {
    Approved: 'bg-emerald-500/15 text-emerald-300',
    Rejected: 'bg-red-500/15 text-red-300',
    'Pending Approval': 'bg-sky-500/15 text-sky-300',
  };

  return <span className={`inline-flex w-fit rounded-full px-2.5 py-1 text-xs font-medium ${styles[status]}`}>{status}</span>;
}

function ChartCard({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3.5 sm:p-5">
      <h3 className="text-base font-semibold">{title}</h3>
      <div className="mt-4">
        {empty ? (
          <div className="flex h-[270px] items-center justify-center text-sm text-slate-500">No receipt data available.</div>
        ) : children}
      </div>
    </div>
  );
}
