export interface Receipt {
  id: string;
  merchant: string;
  date: string;
  category: string;
  total: number;
  currency: string;
  tva?: number;
  ht?: number;
  status: string;
  insight?: string;
  created_at: string;
}

export interface ProcessingResult {
  merchant: string;
  date: string;
  category: string;
  total: number;
  currency: string;
  tva?: number;
  ht?: number;
  insight?: string;
}
