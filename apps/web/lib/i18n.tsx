// ============================================================================
// Requirement #1 — Hindi / English throughout the UI.
//
// A small dictionary rather than a full i18n library: the vocabulary here is
// bounded and domain-specific, and shipping one more dependency to translate ~250
// strings would cost more than it saves. `t()` falls back to English when a Hindi
// string is missing, so a partial translation degrades gracefully instead of
// showing a key.
// ============================================================================
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Lang = 'en' | 'hi';

type Dict = Record<string, { en: string; hi: string }>;

export const STRINGS: Dict = {
  // Navigation
  navOverview:      { en: 'Overview',       hi: 'अवलोकन' },
  navOperations:    { en: 'Operations',     hi: 'संचालन' },
  navRelationships: { en: 'Relationships',  hi: 'सम्बन्ध' },
  navBackOffice:    { en: 'Back office',    hi: 'बैक ऑफिस' },
  navSystem:        { en: 'System',         hi: 'सिस्टम' },
  navDashboard:     { en: 'Dashboard',      hi: 'डैशबोर्ड' },
  navAnalytics:     { en: 'Analytics',      hi: 'विश्लेषण' },
  navBilling:       { en: 'Billing',        hi: 'बिलिंग' },
  navCatalog:       { en: 'Catalog',        hi: 'कैटलॉग' },
  navInventory:     { en: 'Inventory',      hi: 'स्टॉक' },
  navQuotations:    { en: 'Quotations',     hi: 'कोटेशन' },
  navReturns:       { en: 'Returns',        hi: 'वापसी' },
  navCustomers:     { en: 'Customers',      hi: 'ग्राहक' },
  navVendors:       { en: 'Vendors',        hi: 'विक्रेता' },
  navExpenses:      { en: 'Expenses',       hi: 'खर्च' },
  navHR:            { en: 'Staff',          hi: 'स्टाफ' },
  navAdmin:         { en: 'Admin',          hi: 'एडमिन' },

  // Brand
  brandTagline:     { en: 'Smart Business Management', hi: 'स्मार्ट बिज़नेस मैनेजमेंट' },

  // Draft bills — review and edit before finalising (Sections 11, 62)
  draftBill:        { en: 'Draft bill',        hi: 'ड्राफ्ट बिल' },
  drafts:           { en: 'Drafts',            hi: 'ड्राफ्ट' },
  saveDraft:        { en: 'Save as draft',     hi: 'ड्राफ्ट सहेजें' },
  reviewBill:       { en: 'Review bill',       hi: 'बिल जाँचें' },
  editBill:         { en: 'Edit bill',         hi: 'बिल बदलें' },
  finalizeBill:     { en: 'Finalise bill',     hi: 'बिल पक्का करें' },
  discardDraft:     { en: 'Discard draft',     hi: 'ड्राफ्ट हटाएँ' },
  resumeDraft:      { en: 'Resume',            hi: 'जारी रखें' },
  previewPdf:       { en: 'Preview PDF',       hi: 'पीडीएफ देखें' },
  refreshPrices:    { en: 'Refresh prices',    hi: 'दाम ताज़ा करें' },
  noDrafts:         { en: 'No draft bills',    hi: 'कोई ड्राफ्ट बिल नहीं' },
  draftSaved:       { en: 'Draft saved',       hi: 'ड्राफ्ट सहेजा गया' },
  draftNotFinal:    { en: 'Not a tax invoice until finalised', hi: 'पक्का होने तक कर बीजक नहीं' },
  serverRecalculated: { en: 'Recalculated by the server', hi: 'सर्वर द्वारा पुनः गणना' },
  backToCart:       { en: 'Back to cart',      hi: 'कार्ट पर लौटें' },
  businessProfile:  { en: 'Business profile',  hi: 'व्यवसाय प्रोफ़ाइल' },
  printedDocuments: { en: 'Printed documents', hi: 'छपे दस्तावेज़' },

  // Common actions
  save:      { en: 'Save',      hi: 'सहेजें' },
  cancel:    { en: 'Cancel',    hi: 'रद्द करें' },
  create:    { en: 'Create',    hi: 'बनाएँ' },
  edit:      { en: 'Edit',      hi: 'बदलें' },
  close:     { en: 'Close',     hi: 'बंद करें' },
  search:    { en: 'Search',    hi: 'खोजें' },
  add:       { en: 'Add',       hi: 'जोड़ें' },
  remove:    { en: 'Remove',    hi: 'हटाएँ' },
  approve:   { en: 'Approve',   hi: 'मंज़ूर करें' },
  reject:    { en: 'Reject',    hi: 'अस्वीकार करें' },
  refresh:   { en: 'Refresh',   hi: 'ताज़ा करें' },
  export:    { en: 'Export',    hi: 'निर्यात' },
  print:     { en: 'Print',     hi: 'प्रिंट' },
  loading:   { en: 'Loading…',  hi: 'लोड हो रहा है…' },
  noData:    { en: 'No data yet', hi: 'अभी कोई डेटा नहीं' },
  all:       { en: 'All',       hi: 'सभी' },
  total:     { en: 'Total',     hi: 'कुल' },
  branch:    { en: 'Branch',    hi: 'शाखा' },
  allBranches: { en: 'All branches', hi: 'सभी शाखाएँ' },
  signOut:   { en: 'Sign out',  hi: 'साइन आउट' },
  language:  { en: 'Language',  hi: 'भाषा' },
  theme:     { en: 'Theme',     hi: 'थीम' },

  // Dashboard
  revenue:        { en: 'Revenue',          hi: 'बिक्री' },
  invoices:       { en: 'Invoices',         hi: 'बिल' },
  avgTicket:      { en: 'Average bill',     hi: 'औसत बिल' },
  taxCollected:   { en: 'GST collected',    hi: 'जीएसटी संग्रह' },
  lowStockItems:  { en: 'Low stock items',  hi: 'कम स्टॉक आइटम' },
  outstanding:    { en: 'Outstanding dues', hi: 'बकाया' },
  openTills:      { en: 'Open tills',       hi: 'खुले काउंटर' },
  pendingApprovals: { en: 'Pending approvals', hi: 'लंबित स्वीकृतियाँ' },
  last30Days:     { en: 'Last 30 days',     hi: 'पिछले 30 दिन' },

  // Billing
  newBill:      { en: 'New bill',        hi: 'नया बिल' },
  cart:         { en: 'Cart',            hi: 'कार्ट' },
  addItem:      { en: 'Add item',        hi: 'आइटम जोड़ें' },
  quantity:     { en: 'Qty',             hi: 'मात्रा' },
  rate:         { en: 'Rate',            hi: 'दर' },
  discount:     { en: 'Discount',        hi: 'छूट' },
  subtotal:     { en: 'Taxable value',   hi: 'कर योग्य मूल्य' },
  grandTotal:   { en: 'Grand total',     hi: 'कुल राशि' },
  payment:      { en: 'Payment',         hi: 'भुगतान' },
  cash:         { en: 'Cash',            hi: 'नकद' },
  card:         { en: 'Card',            hi: 'कार्ड' },
  credit:       { en: 'Credit',          hi: 'उधार' },
  points:       { en: 'Loyalty points',  hi: 'लॉयल्टी पॉइंट' },
  customer:     { en: 'Customer',        hi: 'ग्राहक' },
  walkIn:       { en: 'Walk-in customer', hi: 'वॉक-इन ग्राहक' },
  completeSale: { en: 'Complete sale',   hi: 'बिक्री पूरी करें' },
  openTill:     { en: 'Open till',       hi: 'काउंटर खोलें' },
  closeTill:    { en: 'Close till',      hi: 'काउंटर बंद करें' },
  cashDrop:     { en: 'Cash drop',       hi: 'नकद निकासी' },

  // Catalog / inventory
  product:      { en: 'Product',      hi: 'उत्पाद' },
  products:     { en: 'Products',     hi: 'उत्पाद' },
  category:     { en: 'Category',     hi: 'श्रेणी' },
  brand:        { en: 'Brand',        hi: 'ब्रांड' },
  sellingPrice: { en: 'Selling price', hi: 'विक्रय मूल्य' },
  mrp:          { en: 'MRP',          hi: 'एमआरपी' },
  stock:        { en: 'Stock',        hi: 'स्टॉक' },
  inStock:      { en: 'In stock',     hi: 'स्टॉक में' },
  lowStock:     { en: 'Low stock',    hi: 'कम स्टॉक' },
  outOfStock:   { en: 'Out of stock', hi: 'स्टॉक ख़त्म' },
  reorderLevel: { en: 'Reorder level', hi: 'पुनःक्रम स्तर' },
  goodsReceipt: { en: 'Goods receipt', hi: 'माल प्राप्ति' },
  transfer:     { en: 'Transfer',     hi: 'स्थानांतरण' },
  writeOff:     { en: 'Write-off',    hi: 'बट्टे खाते' },

  // Customers
  phone:        { en: 'Phone',         hi: 'फ़ोन' },
  name:         { en: 'Name',          hi: 'नाम' },
  balance:      { en: 'Balance owed',  hi: 'बकाया राशि' },
  creditLimit:  { en: 'Credit limit',  hi: 'उधार सीमा' },
  recordPayment:{ en: 'Record payment', hi: 'भुगतान दर्ज करें' },

  // Status
  pending:   { en: 'Pending',   hi: 'लंबित' },
  approved:  { en: 'Approved',  hi: 'स्वीकृत' },
  rejected:  { en: 'Rejected',  hi: 'अस्वीकृत' },
  completed: { en: 'Completed', hi: 'पूर्ण' },
  draft:     { en: 'Draft',     hi: 'ड्राफ़्ट' },
  final:     { en: 'Final',     hi: 'अंतिम' },
  void:      { en: 'Void',      hi: 'रद्द' },
};

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, fallback?: string) => string;
}

const Ctx = createContext<I18nCtx | undefined>(undefined);
const LANG_KEY = 'erp_lang';

export const I18nProvider: React.FC<{ children: React.ReactNode; initial?: Lang }> = ({ children, initial }) => {
  const [lang, setLangState] = useState<Lang>(initial ?? 'en');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LANG_KEY) as Lang | null;
      if (saved === 'en' || saved === 'hi') setLangState(saved);
    } catch { /* private mode — English is a fine default */ }
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = l;
  }, []);

  const t = useCallback((key: string, fallback?: string) => {
    const entry = STRINGS[key];
    if (!entry) return fallback ?? key;
    return entry[lang] || entry.en;
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
