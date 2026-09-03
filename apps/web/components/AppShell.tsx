import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Head from 'next/head';
import useSWR from 'swr';
import { useAuth } from '../lib/AuthContext';
import { useI18n } from '../lib/i18n';
import { NAV_CONFIG } from '../lib/rbac';
import { fetcher } from '../lib/api';
import { BranchFilter } from './ui';
import { Icon } from './icons';
import CommandPalette from './CommandPalette';

type Theme = 'light' | 'dark' | 'system';
const THEME_KEY = 'erp_theme';

function useTheme(): [Theme, (t: Theme) => void] {
  // Light is the hard default: a visitor with no saved preference sees light
  // mode, full stop, regardless of their OS/browser setting. "system" is only
  // ever reached by an explicit user choice, never as the unset default — see
  // the matching no-FOUC script in _document.tsx, which pins the same default
  // before React even hydrates.
  const [theme, setThemeState] = useState<Theme>('light');
  useEffect(() => {
    let saved: Theme | null = null;
    try { saved = localStorage.getItem(THEME_KEY) as Theme | null; } catch { /* ignore */ }
    const effective: Theme = saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'light';
    setThemeState(effective);
    apply(effective);
  }, []);
  function apply(t: Theme) {
    // "system" means removing the attribute entirely, so the prefers-color-scheme
    // media query takes over rather than the app pinning a guess. This only
    // happens once the user has explicitly chosen it — never as a default.
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }
  const setTheme = (t: Theme) => {
    setThemeState(t);
    apply(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  };
  return [theme, setTheme];
}

/** The page title comes from the nav config, so the browser tab, the top bar and
 *  the sidebar can never disagree about what this screen is called. */
function usePageTitle(): string {
  const router = useRouter();
  const { t } = useI18n();
  const item = NAV_CONFIG.flatMap((s) => s.items)
    .find((i) => i.href === router.pathname || (i.href !== '/' && router.pathname.startsWith(i.href)));
  return item ? t(item.labelKey) : 'Dashboard';
}

/** ⌘ on a Mac, Ctrl everywhere else — shown, not guessed at, so the hint on the
 *  search button matches the key that actually works. Falls back to Ctrl during
 *  server rendering, then corrects itself on the client. */
function modKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl ';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl ';
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, can, logout, roleLabel, roleColor } = useAuth();
  const { t, lang, setLang } = useI18n();
  const [theme, setTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const title = usePageTitle();

  // Global shortcuts. Deliberately few, and deliberately not the ones the browser
  // already owns: Ctrl/Cmd+K opens search (no browser meaning), Ctrl/Cmd+N opens a
  // new bill. Anything typed into a field is left alone — a cashier keying a
  // customer's name must never trip a navigation.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const el = document.activeElement as HTMLElement | null;
      const typing = Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
        || el.tagName === 'SELECT' || el.isContentEditable));
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); return; }
      // A new bill from inside a text field would discard what is being typed.
      if (key === 'n' && !typing && can('create_invoice')) {
        e.preventDefault();
        void router.push('/billing?new=1');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [can, router]);

  // Attention counts on the sidebar — the numbers a manager would otherwise have
  // to go looking for. Owner-only, since the endpoint is Owner-only.
  const { data: overview } = useSWR<Record<string, number>>(
    can('view_admin') ? '/api/admin/overview' : null, fetcher, { refreshInterval: 60_000 },
  );

  useEffect(() => { setMenuOpen(false); }, [router.pathname]);

  const counts: Record<string, number> = {
    '/expenses': Number(overview?.pending_expenses ?? 0),
    '/inventory': Number(overview?.transfer_discrepancies ?? 0),
    '/admin': Number(overview?.pending_registrations ?? 0),
    '/billing': Number(overview?.open_stock_conflicts ?? 0),
  };

  const initials = (user?.full_name ?? '?')
    .split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <>
      <Head>
        <title>{`BHAWANI ONE — ${title}`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#131722" />
      </Head>

      <div className="app-shell">
        {menuOpen && <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />}

        <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
          <div className="sidebar-brand">
            <span className="mark" aria-hidden>BO</span>
            <span>
              <span className="name">BHAWANI ONE</span>
              <span className="sub">{t('brandTagline')}</span>
            </span>
          </div>

          <nav>
            {NAV_CONFIG.map((section) => {
              const items = section.items.filter((i) => can(i.permission));
              if (!items.length) return null;
              return (
                <div key={section.sectionKey}>
                  <div className="nav-section">{t(section.sectionKey)}</div>
                  {items.map((item) => {
                    const active = item.href === '/'
                      ? router.pathname === '/'
                      : router.pathname.startsWith(item.href);
                    const count = counts[item.href] ?? 0;
                    return (
                      <Link key={item.href} href={item.href} className={`nav-item${active ? ' active' : ''}`}>
                        <span className="ico"><Icon name={item.icon} size={17} /></span>
                        <span>{t(item.labelKey)}</span>
                        {count > 0 && <span className="count">{count}</span>}
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </nav>

          <div className="sidebar-footer">
            <div className="sidebar-user">
              <span className="avatar" style={{ background: roleColor }} aria-hidden>{initials}</span>
              <span className="who">
                <b>{user?.full_name}</b>
                <span>{roleLabel}</span>
              </span>
            </div>
            <div className="row tight" style={{ padding: '0 8px' }}>
              <button className="pill" style={{ flex: 1 }}
                      onClick={() => setLang(lang === 'en' ? 'hi' : 'en')}
                      title={t('language')}>
                {lang === 'en' ? 'हिन्दी' : 'English'}
              </button>
              <button className="pill icon-pill" aria-label={t('theme')} title={t('theme')}
                      onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}>
                <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} size={15}
                      title={theme === 'dark' ? 'Dark theme' : theme === 'light' ? 'Light theme' : 'Follow system theme'} />
              </button>
            </div>
            <button className="nav-item" onClick={() => void logout()} style={{ width: '100%' }}>
              <span className="ico"><Icon name="signout" size={17} /></span>
              <span>{t('signOut')}</span>
            </button>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button className="icon-btn menu-toggle" onClick={() => setMenuOpen((v) => !v)}
                    aria-label="Menu" aria-expanded={menuOpen}><Icon name="menu" size={17} /></button>
            <h1>{title}</h1>
            <div className="spacer" />
            <button className="topbar-search" onClick={() => setPaletteOpen(true)}
                    aria-label="Search bills, customers and products">
              <Icon name="search" size={15} />
              <span className="topbar-search-label">Search…</span>
              <kbd>{modKeyLabel()}K</kbd>
            </button>
            <BranchFilter />
          </header>
          <main className="content">{children}</main>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
