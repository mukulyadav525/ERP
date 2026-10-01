// ============================================================================
// Record pickers — products, customers, vendors — all built on the one Combobox,
// so every screen that asks for "which product" or "which customer" searches,
// highlights and responds to the keyboard in exactly the same way.
// ============================================================================
import React, { useState } from 'react';
import { apiGet, apiPost, inr, num } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { Combobox } from './Combobox';
import { Badge, Button, Field, Modal } from './ui';

// ── Types shared by the screens that sell, buy and quote ─────────────────────
export interface UnitOption {
  product_unit_id: string;
  unit_code: string;
  name: string;
  print_label: string;
  dimension: string;
  multiplier_to_base: number | string;
  allows_fraction: boolean;
  is_default: boolean;
  is_base: boolean;
}
export interface ProductHit {
  product_id: string; sku: string; name: string; base_unit: string; base_unit_label: string;
  hsn_code: string; default_price_type: 'TAX_INCLUSIVE' | 'TAX_EXCLUSIVE';
  selling_price: string | number | null; mrp?: string | number | null; gst_rate_pct: string | number | null;
  available_qty: string | number | null; reorder_min?: string | number | null;
  batch_tracked: boolean; serial_tracked: boolean; is_active: boolean;
  barcode?: string | null; category_name?: string | null; brand_name?: string | null;
  units: UnitOption[];
  reference_purchase_price?: string | number | null;
}
export interface CustomerHit {
  customer_id: string; name: string; phone: string; whatsapp?: string | null;
  company_name?: string | null; gstin?: string | null; state_code?: string | null;
  customer_type?: string; credit_allowed?: boolean; credit_limit?: string | number;
  balance_owed?: string | number; credit_available?: string | number;
  loyalty_points_balance?: number; is_active?: boolean;
}
export interface VendorHit {
  vendor_id: string; name: string; phone?: string | null; gstin?: string | null;
  state_code?: string | null; balance_owed?: string | number; payment_terms_days?: number | null;
}

/** The unit a product opens on: its default sale unit, else its base unit. */
export function defaultUnit(p: Pick<ProductHit, 'units'>): UnitOption | undefined {
  return p.units.find((u) => u.is_default) ?? p.units.find((u) => u.is_base) ?? p.units[0];
}

/** "₹40.00 / KG · ₹4.00 / 100 G" — the price per unit the product is sold in. */
export function unitPrice(p: ProductHit, u?: UnitOption): string {
  const unit = u ?? defaultUnit(p);
  const base = Number(p.selling_price ?? 0);
  if (!unit) return inr(base, { decimals: true });
  return `${inr(base * Number(unit.multiplier_to_base), { decimals: true })} / ${unit.print_label}`;
}

// ── Product ──────────────────────────────────────────────────────────────────
export function ProductPicker({
  onSelect, placeholder = 'Search products by name, SKU or barcode', autoFocus, inputRef, onSubmitText,
  includeInactive = false, clearOnSelect = true, showStock = true, ariaLabel, onTextChange,
}: {
  onSelect: (p: ProductHit) => void; placeholder?: string; autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement>; onSubmitText?: (text: string) => void;
  includeInactive?: boolean; clearOnSelect?: boolean; showStock?: boolean; ariaLabel?: string;
  onTextChange?: (text: string) => void;
}) {
  return (
    <Combobox<ProductHit>
      placeholder={placeholder}
      ariaLabel={ariaLabel ?? 'Search products'}
      autoFocus={autoFocus}
      inputRef={inputRef}
      clearOnSelect={clearOnSelect}
      minChars={1}
      onSubmitText={onSubmitText}
      onTextChange={onTextChange}
      search={(q) => apiGet<ProductHit[]>(`/api/catalog/products?limit=15&q=${encodeURIComponent(q)}${includeInactive ? '&status=all' : ''}`)}
      getKey={(p) => p.product_id}
      getLabel={(p) => p.name}
      onSelect={(p) => { if (p) onSelect(p); }}
      emptyText="No product matches. Check the spelling, or scan the barcode."
      renderItem={(p) => {
        const avail = Number(p.available_qty ?? 0);
        const u = defaultUnit(p);
        return (
          <>
            <span className="opt-main">
              <span className="opt-title">{p.name}</span>
              <span className="opt-sub mono">{p.sku}{p.barcode ? ` · ${p.barcode}` : ''} · GST {num(p.gst_rate_pct ?? 0, 2)}%</span>
            </span>
            <span className="opt-side">
              <span style={{ display: 'block', fontWeight: 650 }}>{unitPrice(p, u)}</span>
              {showStock && (
                <Badge tone={avail <= 0 ? 'critical' : avail <= Number(p.reorder_min ?? 0) ? 'warning' : 'neutral'}>
                  {avail <= 0 ? 'Out of stock' : `${num(avail, 3)} ${p.base_unit_label}`}
                </Badge>
              )}
            </span>
          </>
        );
      }}
    />
  );
}

// ── Customer (with inline create) ────────────────────────────────────────────
export function CustomerPicker({ value, onSelect, placeholder = 'Customer name, phone or GSTIN', allowCreate = true, inputRef, id }: {
  value: CustomerHit | null; onSelect: (c: CustomerHit | null) => void; placeholder?: string;
  allowCreate?: boolean; inputRef?: React.RefObject<HTMLInputElement>; id?: string;
}) {
  const { can } = useAuth();
  const [creating, setCreating] = useState<string | null>(null);
  const mayCreate = allowCreate && can('edit_customer');
  return (
    <>
      <Combobox<CustomerHit>
        id={id}
        value={value}
        inputRef={inputRef}
        placeholder={placeholder}
        ariaLabel="Customer"
        minChars={1}
        search={(q) => apiGet<CustomerHit[]>(`/api/customers?limit=8&q=${encodeURIComponent(q)}`)}
        getKey={(c) => c.customer_id}
        getLabel={(c) => `${c.name}${c.phone ? ` · ${c.phone}` : ''}`}
        onSelect={onSelect}
        onCreate={mayCreate ? (text) => setCreating(text) : undefined}
        createLabel={(text) => `Add new customer “${text}”`}
        emptyText="No customer found."
        renderItem={(c) => (
          <>
            <span className="opt-main">
              <span className="opt-title">{c.name}{c.company_name ? <span className="muted"> · {c.company_name}</span> : null}</span>
              <span className="opt-sub">{c.phone}{c.gstin ? ` · ${c.gstin}` : ''}</span>
            </span>
            {Number(c.balance_owed ?? 0) > 0 && (
              <span className="opt-side"><Badge tone="warning">owes {inr(c.balance_owed)}</Badge></span>
            )}
          </>
        )}
      />
      {creating !== null && (
        <QuickCustomerModal initial={creating} onClose={() => setCreating(null)}
          onCreated={(c) => { setCreating(null); onSelect(c); }} />
      )}
    </>
  );
}

/** Creates a customer without leaving the screen (spec §13 "without leaving the current form"). */
export function QuickCustomerModal({ initial, onClose, onCreated }: {
  initial: string; onClose: () => void; onCreated: (c: CustomerHit) => void;
}) {
  const toast = useToast();
  const looksLikePhone = /^[\d+\s-]{6,}$/.test(initial.trim());
  const [form, setForm] = useState({
    name: looksLikePhone ? '' : initial.trim(), phone: looksLikePhone ? initial.trim() : '',
    company_name: '', gstin: '', state_code: '', address: '', email: '',
  });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const c = await apiPost<CustomerHit & { already_existed?: boolean }>('/api/customers', {
        ...form, company_name: form.company_name || undefined, gstin: form.gstin || undefined,
        state_code: form.state_code || undefined, address: form.address || undefined, email: form.email || undefined,
      });
      toast.success(c.already_existed ? 'Customer already on file' : 'Customer added',
        c.already_existed ? `${c.name} already uses this phone number — selected.` : c.name);
      onCreated(c);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  return (
    <Modal guardUnsaved open onClose={onClose} title="New customer"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!form.name.trim() || !form.phone.trim()} onClick={() => void save()}>Add customer</Button>
      </>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" required><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Phone" required><input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Company"><input value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} /></Field>
        <Field label="GSTIN" hint="For a GST invoice to a registered business">
          <input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} maxLength={15} />
        </Field>
        <Field label="State" hint="Decides CGST+SGST or IGST"><StateSelect value={form.state_code} onChange={(v) => setForm({ ...form, state_code: v })} /></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <div className="span-2"><Field label="Address"><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field></div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ── Vendor (with inline create) ──────────────────────────────────────────────
export function VendorPicker({ value, onSelect, placeholder = 'Vendor name, phone or GSTIN', id }: {
  value: VendorHit | null; onSelect: (v: VendorHit | null) => void; placeholder?: string; id?: string;
}) {
  const { can } = useAuth();
  const [creating, setCreating] = useState<string | null>(null);
  // A new supplier is added on the spot: leaving a half-typed purchase bill to go
  // to the Vendors screen would lose every line entered so far.
  const mayCreate = can('edit_vendor');
  return (
    <>
      <Combobox<VendorHit>
        id={id}
        value={value}
        placeholder={placeholder}
        ariaLabel="Vendor"
        minChars={0}
        search={(q) => apiGet<VendorHit[]>(`/api/vendors?limit=12${q ? `&q=${encodeURIComponent(q)}` : ''}`)}
        getKey={(v) => v.vendor_id}
        getLabel={(v) => v.name}
        onSelect={onSelect}
        onCreate={mayCreate ? (text) => setCreating(text) : undefined}
        createLabel={(text) => `Add new supplier “${text}”`}
        emptyText={mayCreate ? 'No supplier found.' : 'No supplier found. Ask a manager to add it.'}
        renderItem={(v) => (
          <span className="opt-main">
            <span className="opt-title">{v.name}</span>
            <span className="opt-sub">{[v.phone, v.gstin].filter(Boolean).join(' · ')}</span>
          </span>
        )}
      />
      {creating !== null && (
        <QuickVendorModal initial={creating} onClose={() => setCreating(null)}
          onCreated={(v) => { setCreating(null); onSelect(v); }} />
      )}
    </>
  );
}

/** Adds a supplier without leaving the purchase entry or product form. */
export function QuickVendorModal({ initial, onClose, onCreated }: {
  initial: string; onClose: () => void; onCreated: (v: VendorHit) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ name: initial.trim(), contact_person: '', phone: '', gstin: '', state_code: '', payment_terms_days: '' });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const v = await apiPost<VendorHit>('/api/vendors', {
        name: form.name.trim(), contact_person: form.contact_person || undefined, phone: form.phone || undefined,
        gstin: form.gstin || undefined, state_code: form.state_code || undefined,
        payment_terms_days: form.payment_terms_days ? Number(form.payment_terms_days) : undefined,
      });
      toast.success('Supplier added', v.name);
      onCreated(v);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  return (
    <Modal guardUnsaved open onClose={onClose} title="New supplier"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!form.name.trim()} onClick={() => void save()}>Add supplier</Button>
      </>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" required><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Contact person"><input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} /></Field>
        <Field label="Phone"><input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="GSTIN" hint="Their state is read from it">
          <input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} maxLength={15} />
        </Field>
        <Field label="State" hint="Decides CGST+SGST or IGST on their bills"><StateSelect value={form.state_code} onChange={(v) => setForm({ ...form, state_code: v })} /></Field>
        <Field label="Payment terms (days)"><input inputMode="numeric" value={form.payment_terms_days} onChange={(e) => setForm({ ...form, payment_terms_days: e.target.value.replace(/\D/g, '') })} /></Field>
        <span className="muted small span-2">Bank details, address and an opening balance can be added later on the Vendors screen.</span>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ── GST states ───────────────────────────────────────────────────────────────
export const GST_STATES: Array<[string, string]> = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'],
  ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
  ['97', 'Other Territory'],
];
export function stateName(code: string | null | undefined): string {
  return GST_STATES.find(([c]) => c === code)?.[1] ?? (code ?? '');
}
export function StateSelect({ value, onChange, id, placeholder = 'Select state…' }: {
  value: string; onChange: (code: string) => void; id?: string; placeholder?: string;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {GST_STATES.map(([code, name]) => <option key={code} value={code}>{code} — {name}</option>)}
    </select>
  );
}
