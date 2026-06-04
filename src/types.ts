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
  merchant: string | null;
  transaction_ref: string | null;
  date: string | null;
  category: ReceiptCategory;
  total: number | null;
  currency: string | null;
  tva: number | null;
  ht: number | null;
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
