import type { AppProps } from 'next/app';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import AppShell from '../components/AppShell';
import { AuthProvider, useAuth } from '../lib/AuthContext';
import { I18nProvider } from '../lib/i18n';
import { ToastProvider } from '../lib/ToastContext';
import '../styles/globals.css';

const PUBLIC_PATHS = ['/login'];

/**
 * The global auth gate. It waits for `isLoading` to clear before redirecting —
 * without that, a hard refresh bounces a perfectly valid session to /login while
 * the stored token is still being verified.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  const isPublic = PUBLIC_PATHS.includes(router.pathname);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated && !isPublic) {
      router.replace({ pathname: '/login', query: { next: router.asPath } });
    }
    if (isAuthenticated && isPublic) {
      // Honour ?next= so a deep link survives the sign-in detour.
      const next = typeof router.query.next === 'string' && router.query.next.startsWith('/')
        ? router.query.next : '/';
      router.replace(next);
    }
  }, [isAuthenticated, isLoading, isPublic, router]);

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <span className="spinner" style={{ width: 26, height: 26 }} />
      </div>
    );
  }
  if (!isAuthenticated && !isPublic) return null;
  if (isPublic) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}

export default function App({ Component, pageProps }: AppProps) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <AuthGate>
            <Component {...pageProps} />
          </AuthGate>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
