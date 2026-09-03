// ============================================================================
// One icon set, one stroke weight.
//
// The interface previously mixed colour emoji (🧾 📦 🏭) with geometric Unicode
// glyphs (◧ ◔ ⌕). Those are two different drawing systems: emoji carry their own
// palette and ignore the theme, they render differently on Windows, Android and
// macOS, and they sit on a different baseline from the text beside them. Every
// icon below is a 24×24 monoline path drawn with `currentColor`, so it inherits
// the surrounding text colour, flips with light/dark automatically, and looks the
// same on every platform.
// ============================================================================
import React from 'react';

export type IconName =
  | 'dashboard' | 'analytics' | 'billing' | 'catalog' | 'inventory' | 'quotation'
  | 'returns' | 'customers' | 'vendors' | 'expenses' | 'staff' | 'settings'
  | 'search' | 'plus' | 'check' | 'alert' | 'info' | 'close' | 'menu' | 'signout'
  | 'sun' | 'moon' | 'monitor' | 'branch' | 'chevron' | 'inbox' | 'lock'
  | 'download' | 'print' | 'whatsapp' | 'scan' | 'clock' | 'rupee';

const PATHS: Record<IconName, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  analytics: <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></>,
  billing: <><path d="M6 2h9l4 4v16l-2.5-1.5L14 22l-2-1.5L10 22l-2.5-1.5L5 22V5a3 3 0 0 1 1-3Z" /><path d="M9 9h7" /><path d="M9 13h7" /></>,
  catalog: <><path d="M3 7.5 12 3l9 4.5-9 4.5-9-4.5Z" /><path d="M3 12l9 4.5 9-4.5" /><path d="M3 16.5 12 21l9-4.5" /></>,
  inventory: <><path d="M3 21V9l6-4 6 4v12" /><path d="M15 21V11h6v10" /><path d="M2 21h20" /><path d="M7 13h2" /><path d="M7 17h2" /></>,
  quotation: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6" /><path d="M9 12h6" /><path d="M9 16h3" /></>,
  returns: <><path d="M3 10h11a5 5 0 0 1 0 10H8" /><path d="m7 6-4 4 4 4" /></>,
  customers: <><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M17 11.2a3 3 0 0 0 0-6" /><path d="M18 20a6.3 6.3 0 0 0-3-5.4" /></>,
  vendors: <><path d="M3 9 4.6 4h14.8L21 9" /><path d="M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9Z" /><path d="M9 21v-6h6v6" /></>,
  expenses: <><circle cx="12" cy="12" r="9" /><path d="M9 8h6" /><path d="M9 11h6" /><path d="M14 8c0 2.4-1.6 3.6-4 3.6L14 16" /></>,
  staff: <><circle cx="12" cy="7.5" r="3.5" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 4.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3Z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  check: <><path d="m4 12.5 5 5L20 6.5" /></>,
  alert: <><path d="M12 3.5 22 20H2L12 3.5Z" /><path d="M12 10v4.5" /><path d="M12 17.6h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
  close: <><path d="m5 5 14 14" /><path d="m19 5-14 14" /></>,
  menu: <><path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" /></>,
  signout: <><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M9 16.5 13.5 12 9 7.5" /><path d="M13 12H3" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.9 4.9 1.5 1.5" /><path d="m17.6 17.6 1.5 1.5" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m4.9 19.1 1.5-1.5" /><path d="m17.6 6.4 1.5-1.5" /></>,
  moon: <><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></>,
  monitor: <><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></>,
  branch: <><path d="M3 21V8l9-5 9 5v13" /><path d="M2 21h20" /><path d="M9 21v-6h6v6" /><path d="M7 11h2" /><path d="M15 11h2" /></>,
  chevron: <><path d="m6 9 6 6 6-6" /></>,
  inbox: <><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M4.6 5.4 3 13v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6l-1.6-7.6A2 2 0 0 0 17.4 4H6.6a2 2 0 0 0-2 1.4Z" /></>,
  lock: <><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  download: <><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M4 20h16" /></>,
  print: <><path d="M7 8V3h10v5" /><rect x="3" y="8" width="18" height="8" rx="2" /><path d="M7 14h10v7H7z" /></>,
  whatsapp: <><path d="M3.5 20.5 5 16.4A8.2 8.2 0 1 1 8 19.4l-4.5 1.1Z" /><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5.6 0 1.2-.5 1.2-1.1l-1.6-.8-1 1a6 6 0 0 1-2.7-2.7l1-1L10.6 9c-.7 0-1.6.3-1.6 1Z" /></>,
  scan: <><path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" /><path d="M7.5 8.5v7" /><path d="M10.5 8.5v7" /><path d="M13.5 8.5v7" /><path d="M16.5 8.5v7" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.2 2" /></>,
  rupee: <><path d="M7 4h10" /><path d="M7 8.5h10" /><path d="M14.5 4c0 3.6-2.4 5.4-6 5.4L15.5 20" /></>,
};

/**
 * `size` is in px and defaults to 1em-ish so an icon set beside text keeps its
 * optical weight. Icons are decorative by default (aria-hidden); pass a `title`
 * only when the icon is the *only* label, which the button components avoid.
 */
export function Icon({ name, size = 18, title, className, strokeWidth = 1.7 }: {
  name: IconName; size?: number; title?: string; className?: string; strokeWidth?: number;
}) {
  return (
    <svg
      className={className ? `icon-svg ${className}` : 'icon-svg'}
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

export default Icon;
