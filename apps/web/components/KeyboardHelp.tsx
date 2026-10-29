// The keyboard map — opened with "?" (or F1) from anywhere. Everything in the
// app can be reached from the keyboard; this is the list of the shortcuts that
// make the common paths fast.
import React from 'react';
import { Modal } from './ui';

type Row = [keys: string[], what: string];

const GROUPS: Array<{ title: string; rows: Row[] }> = [
  { title: 'Anywhere', rows: [
    [['?'], 'This list (also F1)'],
    [['Ctrl', 'K'], 'Search everything — products, customers, bills, pages'],
    [['Alt', '1 … 9'], 'Go to the 1st … 9th page in the menu'],
    [['F2'], 'New bill'],
    [['/'], 'Jump to the search box on this page'],
    [['Alt', 'N'], 'This page\'s main "add / new" button'],
    [['[', ']'], 'Previous / next tab on this page'],
    [['Tab', 'Shift Tab'], 'Next / previous field or button'],
    [['Enter'], 'Press the focused button, open the focused row'],
    [['↑', '↓'], 'Move between rows in a list'],
    [['Esc'], 'Close the open window'],
  ] },
  { title: 'Billing', rows: [
    [['F3'], 'Item search (or scan)'],
    [['↑', '↓', 'Enter'], 'Pick an item from the suggestions'],
    [['↑'], 'From an empty search: up into the cart'],
    [['↑', '↓'], 'In the cart: same column, next / previous line'],
    [['Enter'], 'In the cart: back to the item search'],
    [['Ctrl', 'Delete'], 'In the cart: remove that line'],
    [['F4'], 'Customer'],
    [['F6'], 'Switch GST / non-GST'],
    [['F7'], 'Payment amount'],
    [['F9'], 'Review the bill (also Ctrl S)'],
    [['F10'], 'Move to Complete sale / Finalise — then Enter'],
    [['F8'], 'After the sale: thermal receipt'],
    [['Ctrl', 'P'], 'After the sale: print the A4 bill'],
  ] },
];

export default function KeyboardHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} wide title="Keyboard shortcuts">
      <div className="grid cols-2">
        {GROUPS.map((g) => (
          <div key={g.title} className="stack" style={{ gap: 6 }}>
            <b>{g.title}</b>
            {g.rows.map(([keys, what]) => (
              <div key={`${g.title}:${keys.join('+')}:${what}`} className="row tight small" style={{ alignItems: 'baseline' }}>
                <span style={{ minWidth: 120 }}>{keys.map((k) => <kbd key={k} style={{ marginRight: 3 }}>{k}</kbd>)}</span>
                <span className="muted" style={{ flex: 1 }}>{what}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>
        On a Mac, Ctrl is ⌘ and Alt is ⌥ Option. Shortcuts with a single key (? / [ ]) do nothing while you are typing in a box.
      </p>
    </Modal>
  );
}
