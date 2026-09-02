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

type Theme = 'light' | 'dark' | 'system';
const THEME_KEY = 'erp_theme';

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>('system');
  useEffect(() => {
    let saved: Theme = 'system';
    try { saved = (localStorage.getItem(THEME_KEY) as Theme) || 'system'; } catch { /* ignore */ }
    setThemeState(saved);
    apply(saved);
  }, []);
  function apply(t: Theme) {
    // "system" means removing the attribute entirely, so the prefers-color-scheme
    // media query takes over rather than the app pinning a guess.
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
  return item ? t(item.labelKey) : 'Hardware ERP';
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, can, logout, roleLabel, roleColor } = useAuth();
  const { t, lang, setLang } = useI18n();
  const [theme, setTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const title = usePageTitle();

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
        <title>{`${title} · Hardware ERP`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#131722" />
      </Head>

      <div className="app-shell">
        {menuOpen && <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />}

        <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
          <div className="sidebar-brand">
            <span className="mark" aria-hidden>HE</span>
            <span>
              <span className="name">Hardware ERP</span>
              <span className="sub">Multi-branch</span>
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
                        <span className="ico" aria-hidden>{item.icon}</span>
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
              <button className="pill" title={t('theme')}
                      onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}>
                {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
              </button>
            </div>
            <button className="nav-item" onClick={() => void logout()} style={{ width: '100%' }}>
              <span className="ico" aria-hidden>⇥</span>
              <span>{t('signOut')}</span>
            </button>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button className="icon-btn menu-toggle" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">☰</button>
            <h1>{title}</h1>
            <div className="spacer" />
            <BranchFilter />
          </header>
          <main className="content">{children}</main>
        </div>
      </div>
    </>
  );
}
