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
const chartColors = ['#F97316', '#14B8A6', '#60A5FA', '#A78BFA', '#FACC15', '#FB7185', '#34D399', '#94A3B8'];
const defaultSettings: DashboardSettings = { defaultCurrency: 'MAD', vatLabel: 'TVA récupérable', compactMode: false };

type Page = 'dashboard' | 'analytics' | 'settings';

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
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
  const [filters, setFilters] = useState<ReceiptFilters>({
    month: getCurrentMonth(),
    category: 'All',
    status: 'All',
    search: '',
    from: '',
    to: '',
  });
  const [settings, setSettings] = useState<DashboardSettings>(() => {
    try {
      return { ...defaultSettings, ...JSON.parse(localStorage.getItem('receiptai-settings') || '{}') };
    } catch {
      return defaultSettings;
    }
  });
  const [editForm, setEditForm] = useState<ReceiptFormState | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [health, setHealth] = useState('checking');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const receiptRequestRef = useRef(0);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]: [string, string]) => {
      if (value && value !== 'All') params.set(key, value);
    });
    params.set('display_currency', settings.defaultCurrency);
    return params.toString();
  }, [filters, settings.defaultCurrency]);

  const fetchReceipts = useCallback(async () => {
    const requestId = ++receiptRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/receipts?${queryString}`);
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to load receipts.');
      if (requestId !== receiptRequestRef.current) return;
      setReceipts(data.receipts || []);
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
  }, [queryString]);

  useEffect(() => {
    fetchReceipts();
  }, [fetchReceipts]);

  useEffect(() => {
    localStorage.setItem('receiptai-settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    fetch('/api/health')
      .then(readApiResponse)
      .then(data => setHealth(data.supabase === 'ok' ? 'connected' : data.supabase || 'error'))
      .catch(() => setHealth('offline'));
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
    return { total, tva, average, counts, excluded: receipts.length - converted.length };
  }, [receipts, settings.defaultCurrency]);

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
    try {
      const formData = new FormData();
      formData.append('receipt', file);
      formData.append('display_currency', settings.defaultCurrency);
      const res = await fetch('/api/receipts/process', { method: 'POST', body: formData });
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to process receipt.');
      setReceipts(prev => [data.receipt, ...prev]);
      setSelectedReceipt(data.receipt);
      setPage('dashboard');
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
      };
      const res = await fetch(`/api/receipts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to save receipt.');
      setReceipts(prev => prev.map(receipt => (receipt.id === id ? data.receipt : receipt)));
      setSelectedReceipt(data.receipt);
      setEditForm(null);
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
      setReceipts(prev => prev.map(receipt => (receipt.id === selectedReceipt.id ? data.receipt : receipt)));
      setSelectedReceipt(data.receipt);
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
      const remaining = receipts.filter(receipt => receipt.id !== selectedReceipt.id);
      setReceipts(remaining);
      setSelectedReceipt(remaining[0] || null);
    } catch (err: any) {
      setError(err.message || 'Delete failed.');
    } finally {
      setSaving(false);
    }
  }

  async function exportPdf() {
    if (!selectedReceipt) return;
    setError('');
    try {
      const res = await fetch(`/api/receipts/${selectedReceipt.id}/export-pdf`);
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

  const navItems = [
    { page: 'dashboard' as const, label: 'Dashboard', icon: Home },
    { page: 'analytics' as const, label: 'Analytics', icon: BarChart3 },
    { page: 'settings' as const, label: 'Settings', icon: Settings },
  ];

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
            <p className="text-xs text-slate-500">AI expense operations</p>
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
          <p className="text-xs uppercase tracking-wide text-slate-500">Supabase</p>
          <p className={`mt-1 text-sm font-medium ${health === 'connected' ? 'text-emerald-400' : 'text-amber-300'}`}>{health}</p>
        </div>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-10 border-b border-white/10 bg-[#080808]/80 px-4 py-4 backdrop-blur-xl md:px-8">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-orange-400">Moroccan finance dashboard</p>
              <h2 className="mt-1 text-2xl font-semibold md:text-3xl">
                {page === 'dashboard' ? 'Receipt control center' : page === 'analytics' ? 'Expense analytics' : 'Workspace settings'}
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-slate-300">
                <span className="hidden sm:inline">Currency</span>
                <select
                  value={settings.defaultCurrency}
                  onChange={event => setSettings(prev => ({ ...prev, defaultCurrency: event.target.value }))}
                  className="bg-transparent font-semibold text-white outline-none"
                  aria-label="Dashboard currency"
                >
                  {dashboardCurrencies.map(currency => <option key={currency} value={currency} className="bg-neutral-900">{currency}</option>)}
                </select>
              </label>
              <button
                onClick={fetchReceipts}
                disabled={loading}
                className="flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-slate-200 transition hover:bg-white/10 disabled:opacity-60"
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                Refresh
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex h-10 items-center gap-2 rounded-lg bg-orange-500 px-4 text-sm font-bold text-black transition hover:bg-orange-400 disabled:opacity-60"
              >
                {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                Upload
              </button>
            </div>
          </div>
        </header>

        <main className={`px-4 py-6 md:px-8 ${settings.compactMode ? 'space-y-4' : 'space-y-6'}`}>
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
              <X size={18} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {totals.excluded > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
              {totals.excluded} receipt{totals.excluded === 1 ? '' : 's'} excluded from totals because conversion to {settings.defaultCurrency} is unavailable or pending.
            </div>
          )}

          {page === 'dashboard' && (
            <>
              <section className="grid grid-cols-1 gap-3 xl:grid-cols-[1.5fr_1fr_1fr_1fr]">
                <Kpi title="Monthly Total" value={money(totals.total, settings.defaultCurrency)} icon={CircleDollarSign} />
                <Kpi title={settings.vatLabel} value={money(totals.tva, settings.defaultCurrency)} icon={FileText} />
                <Kpi title="Pending" value={String(totals.counts['Pending Approval'] || 0)} icon={SlidersHorizontal} />
                <Kpi title="Approved" value={String(totals.counts.Approved || 0)} icon={Check} />
              </section>

              <FilterBar filters={filters} setFilters={setFilters} />

              <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_390px]">
                <div className="space-y-6">
                  <UploadZone uploading={uploading} onPick={() => fileInputRef.current?.click()} />
                  <ReceiptTable
                    receipts={receipts}
                    selectedId={selectedReceipt?.id}
                    loading={loading}
                    currency={settings.defaultCurrency}
                    onSelect={receipt => {
                      setSelectedReceipt(receipt);
                      setEditForm(null);
                    }}
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
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <Kpi title="Total expenses" value={money(totals.total, settings.defaultCurrency)} icon={CircleDollarSign} />
                <Kpi title="TVA total" value={money(totals.tva, settings.defaultCurrency)} icon={FileText} />
                <Kpi title="Average receipt" value={money(totals.average, settings.defaultCurrency)} icon={PieChartIcon} />
                <Kpi title="Receipts" value={String(receipts.length)} icon={FileText} />
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
            <section className="max-w-3xl rounded-lg border border-white/10 bg-white/[0.05] p-6 shadow-2xl shadow-black/20 backdrop-blur">
              <h3 className="text-lg font-semibold">Dashboard preferences</h3>
              <div className="mt-6 grid gap-5">
                <label className="grid gap-2 text-sm">
                  <span className="text-slate-400">Default currency</span>
                  <select
                    value={settings.defaultCurrency}
                    onChange={event => setSettings(prev => ({ ...prev, defaultCurrency: event.target.value }))}
                    className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 outline-none focus:border-orange-500"
                  >
                    {dashboardCurrencies.map(currency => <option key={currency}>{currency}</option>)}
                  </select>
                </label>
                <label className="grid gap-2 text-sm">
                  <span className="text-slate-400">VAT label</span>
                  <input
                    value={settings.vatLabel}
                    onChange={event => setSettings(prev => ({ ...prev, vatLabel: event.target.value }))}
                    className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 outline-none focus:border-orange-500"
                  />
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

      <footer className="fixed bottom-0 left-0 right-0 z-30 border-t border-white/10 bg-black/80 px-4 py-3 backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-md items-center justify-between">
          {navItems.slice(0, 2).map(item => {
            const Icon = item.icon;
            return (
              <button key={item.page} onClick={() => setPage(item.page)} className={`rounded-lg p-3 ${page === item.page ? 'bg-orange-500 text-black' : 'text-slate-400'}`}>
                <Icon size={21} />
              </button>
            );
          })}
          <button onClick={() => fileInputRef.current?.click()} className="rounded-full bg-orange-500 p-4 text-black shadow-lg shadow-orange-500/30">
            <Upload size={22} />
          </button>
          <button onClick={() => setPage('settings')} className={`rounded-lg p-3 ${page === 'settings' ? 'bg-orange-500 text-black' : 'text-slate-400'}`}>
            <Settings size={21} />
          </button>
        </div>
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
    <div className="rounded-lg border border-white/10 bg-white/[0.05] p-5 shadow-2xl shadow-black/20 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-slate-500">{title}</p>
        <Icon size={18} className="text-orange-400" />
      </div>
      <p className="mt-3 break-words text-2xl font-semibold text-white">{value}</p>
    </div>
  );
}

function FilterBar({ filters, setFilters }: { filters: ReceiptFilters; setFilters: React.Dispatch<React.SetStateAction<ReceiptFilters>> }) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.04] p-4 backdrop-blur">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-300">
        <Filter size={17} className="text-orange-400" />
        Filters
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
        <input
          type="month"
          value={filters.month}
          onChange={event => setFilters(prev => ({ ...prev, month: event.target.value }))}
          className="h-10 rounded-lg border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-orange-500"
        />
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
        <button
          onClick={() => setFilters({ month: getCurrentMonth(), category: 'All', status: 'All', search: '', from: '', to: '' })}
          className="h-10 rounded-lg border border-white/10 bg-white/5 px-3 text-sm transition hover:bg-white/10"
        >
          Reset
        </button>
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
      className="group flex min-h-44 w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-white/10 bg-white/[0.03] p-8 text-center transition hover:border-orange-500/70 hover:bg-orange-500/5 disabled:opacity-70"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-orange-500/15 text-orange-400 transition group-hover:scale-105">
        {uploading ? <Loader2 className="animate-spin" size={26} /> : <Upload size={26} />}
      </div>
      <p className="mt-4 text-lg font-semibold">{uploading ? 'Extracting receipt data...' : 'Upload JPG, PNG, or PDF receipt'}</p>
      <p className="mt-1 text-sm text-slate-500">OpenAI extracts the printed values, then ReceiptAI converts them using dated exchange rates.</p>
    </button>
  );
}

function ReceiptTable({
  receipts,
  selectedId,
  loading,
  currency,
  onSelect,
}: {
  receipts: Receipt[];
  selectedId?: string;
  loading: boolean;
  currency: string;
  onSelect: (receipt: Receipt) => void;
}) {
  if (loading) {
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
        <p className="mt-3 text-lg font-semibold">No receipts found</p>
        <p className="mt-1 max-w-md text-sm text-slate-500">Upload a receipt or adjust filters to populate the dashboard with real Supabase data.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]">
      <div className="grid grid-cols-[1.2fr_0.8fr_0.7fr_0.7fr_32px] gap-3 border-b border-white/10 px-4 py-3 text-xs uppercase tracking-wide text-slate-500">
        <span>Merchant</span>
        <span>Category</span>
        <span>Status</span>
        <span className="text-right">Total</span>
        <span />
      </div>
      {receipts.map(receipt => (
        <button
          key={receipt.id}
          onClick={() => onSelect(receipt)}
          className={`grid w-full grid-cols-[1.2fr_0.8fr_0.7fr_0.7fr_32px] items-center gap-3 border-b border-white/5 px-4 py-4 text-left text-sm transition last:border-0 ${
            selectedId === receipt.id ? 'bg-orange-500/10' : 'hover:bg-white/[0.06]'
          }`}
        >
          <span className="min-w-0">
            <span className="block truncate font-medium">{receipt.merchant || 'Unknown merchant'}</span>
            <span className="block truncate text-xs text-slate-500">{receipt.date || receipt.created_at?.slice(0, 10)} • {receipt.transaction_ref || receipt.id.slice(0, 8)}</span>
          </span>
          <span className="truncate text-slate-300">{receipt.category}</span>
          <StatusPill status={receipt.status} />
          <span className="text-right">
            <span className="block font-semibold">Original: {money(receipt.original_total ?? receipt.total, receipt.original_currency || receipt.currency || 'MAD')}</span>
            {receipt.converted_total !== null && receipt.display_currency === currency ? (
              <span className="block text-xs text-emerald-300">Converted: {money(receipt.converted_total, receipt.display_currency)}</span>
            ) : (
              <span className="block text-xs text-amber-300">Conversion unavailable</span>
            )}
          </span>
          <ChevronRight size={17} className="text-slate-500" />
        </button>
      ))}
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
  onExport: () => void;
  onSave: () => void;
  setForm: React.Dispatch<React.SetStateAction<ReceiptFormState | null>>;
  saving: boolean;
  displayCurrency: string;
}) {
  if (!receipt) {
    return (
      <aside className="flex min-h-[520px] flex-col items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] p-8 text-center">
        <FileText size={34} className="text-slate-500" />
        <p className="mt-3 text-lg font-semibold">Select a receipt</p>
        <p className="mt-1 text-sm text-slate-500">Receipt details, approval workflow, edits, and PDF export will appear here.</p>
      </aside>
    );
  }

  const form = editForm;
  return (
    <aside className="rounded-lg border border-white/10 bg-white/[0.05] p-5 shadow-2xl shadow-black/20 backdrop-blur">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <StatusPill status={receipt.status} />
          <h3 className="mt-3 truncate text-2xl font-semibold">{receipt.merchant || 'Unknown merchant'}</h3>
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
            <p className="mt-1 text-3xl font-bold">{money(receipt.original_total ?? receipt.total, receipt.original_currency || receipt.currency || 'MAD')}</p>
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
          <div className="mt-5 grid grid-cols-3 gap-2">
            <button onClick={onApprove} disabled={saving} className="rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-emerald-300 transition hover:bg-emerald-500/25">Approve</button>
            <button onClick={onReject} disabled={saving} className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300 transition hover:bg-red-500/25">Reject</button>
            <button onClick={onPending} disabled={saving} className="rounded-lg bg-sky-500/15 px-3 py-2 text-sm text-sky-300 transition hover:bg-sky-500/25">Pending</button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={onExport} className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm transition hover:bg-white/10">
              <Download size={16} />
              Export PDF
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
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
      <h3 className="text-base font-semibold">{title}</h3>
      <div className="mt-4">
        {empty ? (
          <div className="flex h-[270px] items-center justify-center text-sm text-slate-500">No receipt data available.</div>
        ) : children}
      </div>
    </div>
  );
}
