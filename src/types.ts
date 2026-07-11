export type Category = {
  id: string;
  name: string;
  color: string;
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
