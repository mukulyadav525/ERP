// ============================================================================
// The one searchable picker (spec §17, §18).
//
// Every search-as-you-type field in the app is this component, so they all
// behave the same way at the keyboard and none of them can lose focus while the
// person is typing. Three decisions make that true:
//
//   1. The <input> is ALWAYS the same DOM node. Loading, empty and error states
//      and the result list render BESIDE it (in a portal), never around it, so no
//      state change can unmount and remount the field under the caret.
//   2. The query is local state and results are keyed to the query that produced
//      them: a slow response for "ha" can never overwrite the list for "hammer",
//      and Enter never selects a row belonging to an older query.
//   3. Callers pass plain functions; they are read through refs, so an inline
//      arrow function in the parent does not re-trigger a search every render.
//
// Keyboard: ↓/↑ move (and wrap), Home/End jump, Enter picks the highlighted row
// (or hands the raw text to `onSubmitText` — how a barcode scanner's Enter is
// handled), Escape closes the list and then clears, Tab moves on.
// ============================================================================
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';

export interface ComboboxProps<T> {
  /** The selected item, or null. Omit for a pure search box (e.g. the POS item search). */
  value?: T | null;
  onSelect: (item: T | null) => void;
  /** Returns the options for a query. Called debounced; may be async. */
  search: (query: string) => Promise<T[]> | T[];
  getKey: (item: T) => string;
  /** Text shown in the field for the selected item. */
  getLabel: (item: T) => string;
  /** Row content in the list; defaults to the label. */
  renderItem?: (item: T, active: boolean) => React.ReactNode;
  placeholder?: string;
  /** Characters needed before searching; 0 shows options on focus. */
  minChars?: number;
  debounceMs?: number;
  /** Clear the text after a pick (a search box that adds items, rather than a picker). */
  clearOnSelect?: boolean;
  /** Enter with no highlighted row — e.g. a scanned barcode that must be looked up exactly. */
  onSubmitText?: (text: string) => void;
  /** "+ Add new …" at the bottom of the list. Receives the typed text. */
  onCreate?: (text: string) => void;
  createLabel?: (text: string) => string;
  emptyText?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  inputRef?: React.RefObject<HTMLInputElement>;
  ariaLabel?: string;
  id?: string;
  /** Allow clearing the selection with the × button. */
  clearable?: boolean;
  invalid?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  /** Called on every keystroke with the current text (e.g. to show an "unknown code" hint). */
  onTextChange?: (text: string) => void;
}

export function Combobox<T>(props: ComboboxProps<T>) {
  const {
    value = null, onSelect, getKey, getLabel, renderItem, placeholder, minChars = 1,
    debounceMs = 180, clearOnSelect = false, onCreate, createLabel, emptyText = 'No matches',
    autoFocus, disabled, ariaLabel, clearable = true, invalid, inputMode,
  } = props;
  const reactId = useId();
  const listId = `${props.id ?? reactId}-list`;
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = props.inputRef ?? ownRef;
  const wrapRef = useRef<HTMLDivElement>(null);

  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<T[]>([]);
  const [itemsFor, setItemsFor] = useState<string | null>(null);  // the query `items` belong to
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; maxH: number; above: boolean } | null>(null);

  // Read the caller's functions through refs: an inline arrow in the parent is a
  // new function every render, and depending on it would re-run the search forever.
  const searchRef = useRef(props.search); searchRef.current = props.search;
  const submitRef = useRef(props.onSubmitText); submitRef.current = props.onSubmitText;
  const textChangeRef = useRef(props.onTextChange); textChangeRef.current = props.onTextChange;
  const seq = useRef(0);
  // Enter pressed before the results for the typed text arrived: remembered, and
  // honoured with the top result for THAT text when it lands — never with a list
  // that belonged to something typed earlier.
  const pendingEnter = useRef<string | null>(null);

  const query = text.trim();
  const hasCreate = Boolean(onCreate && query);
  const rowCount = items.length + (hasCreate ? 1 : 0);
  const listCurrent = itemsFor === query;

  // ── Search, debounced, newest-wins ──────────────────────────────────────────
  useEffect(() => {
    if (!focused || !open) return;
    if (query.length < minChars) {
      setItems([]); setItemsFor(query); setLoading(false); setFailed(null);
      if (minChars > 0) return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const handle = window.setTimeout(() => {
      Promise.resolve()
        .then(() => searchRef.current(query))
        .then((rows) => {
          if (mine !== seq.current) return;
          setItems(rows ?? []); setItemsFor(query); setFailed(null);
          setActive(0);
          if (pendingEnter.current === query) {
            pendingEnter.current = null;
            if (rows?.length) chooseRef.current(rows[0]);
          }
        })
        .catch((err) => {
          if (mine !== seq.current) return;
          setItems([]); setItemsFor(query);
          setFailed(err instanceof Error ? err.message : 'Search is unavailable right now.');
        })
        .finally(() => { if (mine === seq.current) setLoading(false); });
    }, query.length === 0 ? 0 : debounceMs);
    return () => window.clearTimeout(handle);
  }, [query, focused, open, minChars, debounceMs]);

  // ── Position the list next to the field (portal: never clipped by a modal) ──
  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const useAbove = below < 220 && above > below;
    setRect({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 260) - 8)),
      top: useAbove ? r.top - 4 : r.bottom + 4,
      width: Math.max(r.width, Math.min(260, window.innerWidth - 16)),
      maxH: Math.max(160, Math.min(340, useAbove ? above : below)),
      above: useAbove,
    });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => { window.removeEventListener('resize', onMove); window.removeEventListener('scroll', onMove, true); };
  }, [open, place]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);

  const choose = useCallback((item: T | null) => {
    pendingEnter.current = null;
    onSelect(item);
    setOpen(false);
    setText(clearOnSelect || item === null ? '' : (item ? getLabel(item) : ''));
    if (clearOnSelect) { setItems([]); setItemsFor(null); }
  }, [onSelect, clearOnSelect, getLabel]);
  const chooseRef = useRef(choose); chooseRef.current = choose;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (rowCount) setActive((a) => (a + 1) % rowCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (rowCount) setActive((a) => (a - 1 + rowCount) % rowCount);
    } else if (e.key === 'Home' && open && rowCount) {
      e.preventDefault(); setActive(0);
    } else if (e.key === 'End' && open && rowCount) {
      e.preventDefault(); setActive(rowCount - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // A row is only picked if the list on screen belongs to what is typed now.
      // A scanner types a code and presses Enter faster than any search returns;
      // selecting the stale first row would add the wrong item to the bill.
      if (open && listCurrent && !loading && active < items.length && items[active]) {
        choose(items[active]);
      } else if (open && listCurrent && hasCreate && active === items.length) {
        onCreate?.(query); setOpen(false);
      } else if (query && submitRef.current) {
        submitRef.current(query);
        if (clearOnSelect) setText('');
        setOpen(false);
      } else if (query && query.length >= minChars) {
        // Results for this text are still on their way: pick the top one when they arrive.
        pendingEnter.current = query;
      }
    } else if (e.key === 'Escape') {
      pendingEnter.current = null;
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
      else if (text) { e.preventDefault(); e.stopPropagation(); setText(value ? getLabel(value) : ''); }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  const shownText = focused || !value ? text : getLabel(value);
  const showList = open && focused && (query.length >= minChars || minChars === 0);

  return (
    <div className={`combo${disabled ? ' disabled' : ''}`} ref={wrapRef}>
      <span className="combo-icon" aria-hidden><Icon name="search" size={15} /></span>
      <input
        ref={inputRef}
        id={props.id}
        type="text"
        role="combobox"
        aria-label={ariaLabel ?? placeholder}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && rowCount ? `${listId}-${active}` : undefined}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode={inputMode}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={value && !focused ? undefined : placeholder}
        value={shownText}
        onChange={(e) => {
          pendingEnter.current = null;
          setText(e.target.value);
          setOpen(true);
          setActive(0);
          textChangeRef.current?.(e.target.value);
        }}
        onFocus={(e) => {
          setFocused(true);
          if (value && !clearOnSelect) { setText(getLabel(value)); requestAnimationFrame(() => e.target.select()); }
          if (minChars === 0) setOpen(true);
        }}
        onBlur={() => { pendingEnter.current = null; setFocused(false); setOpen(false); if (!clearOnSelect) setText(''); }}
        onKeyDown={onKeyDown}
        onClick={() => setOpen(true)}
      />
      {loading && focused && <span className="spinner combo-spinner" aria-label="Searching" />}
      {clearable && value && !focused && !disabled && (
        <button type="button" className="combo-clear" aria-label="Clear"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { choose(null); inputRef.current?.focus(); }}>
          <Icon name="close" size={14} />
        </button>
      )}

      {showList && rect && typeof document !== 'undefined' && createPortal(
        <div
          className="combo-pop"
          style={{
            left: rect.left, width: rect.width, maxHeight: rect.maxH,
            ...(rect.above ? { bottom: window.innerHeight - rect.top } : { top: rect.top }),
          }}
          // Keeps focus in the field while the list is clicked.
          onMouseDown={(e) => e.preventDefault()}
        >
          <ul id={listId} role="listbox" className="combo-list" aria-label={ariaLabel ?? placeholder}>
            {items.map((item, i) => (
              <li key={getKey(item)} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                  className={`combo-option${i === active ? ' active' : ''}${value && getKey(value) === getKey(item) ? ' selected' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(item)}>
                {renderItem ? renderItem(item, i === active) : getLabel(item)}
              </li>
            ))}
            {hasCreate && (
              <li id={`${listId}-${items.length}`} role="option" aria-selected={active === items.length}
                  className={`combo-option combo-create${active === items.length ? ' active' : ''}`}
                  onMouseEnter={() => setActive(items.length)}
                  onClick={() => { onCreate?.(query); setOpen(false); }}>
                <Icon name="plus" size={14} /> {createLabel ? createLabel(query) : `Add “${query}”`}
              </li>
            )}
          </ul>
          {!items.length && !hasCreate && (
            <div className="combo-msg">
              {failed ? failed : loading || !listCurrent ? 'Searching…' : emptyText}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * A client-side filter for static option lists (units, states, branches): case-
 * and accent-insensitive, matching any word start first, then anywhere.
 */
export function filterOptions<T>(items: T[], query: string, label: (t: T) => string, limit = 50): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const starts: T[] = [];
  const contains: T[] = [];
  for (const it of items) {
    const l = label(it).toLowerCase();
    if (l.startsWith(q) || l.split(/[\s(/-]+/).some((w) => w.startsWith(q))) starts.push(it);
    else if (l.includes(q)) contains.push(it);
  }
  return [...starts, ...contains].slice(0, limit);
}
