export type ReceiptStatus = 'Pending Approval' | 'Approved' | 'Rejected';

export type ReceiptCategory =
  | 'Meals'
  | 'Transport'
  | 'Software'
  | 'Office'
  | 'Fuel'
  | 'Travel'
  | 'Utilities'
  | 'Other';

export interface Receipt {
  id: string;
  user_id: string | null;
  merchant: string | null;
  transaction_ref: string | null;
  date: string | null;
  category: ReceiptCategory;
  total: number | null;
  currency: string | null;
  tva: number | null;
  ht: number | null;
  receipt_date: string | null;
  original_currency: string | null;
  original_total: number | null;
  original_ht: number | null;
  original_tva: number | null;
  display_currency: string | null;
  converted_total: number | null;
  converted_ht: number | null;
  converted_tva: number | null;
  exchange_rate: number | null;
  exchange_rate_date: string | null;
  exchange_rate_source: 'historical' | 'latest' | 'identity' | 'failed' | null;
  conversion_warning: string | null;
  status: ReceiptStatus;
  insight: string | null;
  file_name: string | null;
  file_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReceiptFilters {
  month: string;
  category: 'All' | ReceiptCategory;
  status: 'All' | ReceiptStatus;
  search: string;
  from: string;
  to: string;
}

export interface DashboardSettings {
  defaultCurrency: string;
  conversionRateMode: 'latest' | 'historical';
  vatLabel: string;
  compactMode: boolean;
}

export interface ReceiptFormState {
  merchant: string;
  transaction_ref: string;
  date: string;
  category: ReceiptCategory;
  total: string;
  currency: string;
  ht: string;
  tva: string;
  insight: string;
  status: ReceiptStatus;
}
