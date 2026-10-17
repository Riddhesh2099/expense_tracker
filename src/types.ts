export type Category = {
  id: string;
  name: string;
  color: string;
  /** Monthly budget in INR; 0 or missing means no budget. */
  budget?: number;
  createdAt: Date;
};

export type Expense = {
  id: string;
  title: string;
  merchant: string;
  amount: number;
  currency: string;
  categoryId: string;
  paymentMethod: string;
  notes: string;
  expenseDate: Date;
  createdAt: Date;
};

export type SortKey = "date-desc" | "date-asc" | "amount-desc" | "amount-asc" | "title";

export type DateRange = "all" | "month" | "year";
