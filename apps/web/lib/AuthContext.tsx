import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import {
  apiGet, apiPost, clearStoredSession, readStoredSession, setStoredSession, setUnauthorizedHandler,
} from './api';
import { canAccess, ROLE_META, type UserRole } from './rbac';

export interface AuthUser {
  user_id: string;
  role: UserRole;
  branch_id: string | null;      // null only for OWNER_ADMIN (chain-wide)
  branch_name?: string | null;
  full_name: string;
  email?: string | null;
  phone?: string | null;
  language_pref?: 'en' | 'hi';
  must_change_password?: boolean;
}

export interface Branch {
  branch_id: string; name: string; address?: string | null;
  state_code?: string; gstin?: string | null; phone?: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  /** True until the stored session has been checked — pages must not redirect
   *  before this is false, or a hard refresh bounces a signed-in user to /login. */
  isLoading: boolean;
  branches: Branch[];
  /** The branch currently being viewed. For every role except OWNER_ADMIN this is
   *  their own branch and cannot be changed. */
  activeBranchId: string | null;
  activeBranchName: string;
  setActiveBranchId: (id: string | null) => void;
  login: (token: string, user: AuthUser) => void;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
  roleLabel: string;
  roleColor: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const BRANCH_KEY = 'erp_active_branch';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [activeBranchId, setActiveBranch] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);

  // Restore, then confirm with the server. A token in localStorage proves nothing
  // — it may have expired or been revoked — so /me is the source of truth.
  useEffect(() => {
    const stored = readStoredSession<AuthUser>();
    if (!stored) { setLoading(false); return; }
    setUser(stored.user);
    apiGet<AuthUser>('/api/auth/me')
      .then((fresh) => {
        setUser(fresh);
        setStoredSession(stored.token, fresh);
        if (fresh.role === 'OWNER_ADMIN') {
          let saved: string | null = null;
          try { saved = localStorage.getItem(BRANCH_KEY); } catch { /* ignore */ }
          setActiveBranch(saved);
        } else {
          setActiveBranch(fresh.branch_id);
        }
      })
      .catch(() => { clearStoredSession(); setUser(null); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) { setBranches([]); return; }
    apiGet<Branch[]>('/api/auth/branches').then(setBranches).catch(() => setBranches([]));
  }, [user]);

  const login = useCallback((token: string, u: AuthUser) => {
    setStoredSession(token, u);
    setUser(u);
    setActiveBranch(u.role === 'OWNER_ADMIN' ? null : u.branch_id);
    setLoading(false);
    // The login response carries the claims the server was willing to issue; /me
    // adds the display details (branch name, language) the UI needs. Without this
    // the branch badge reads "Branch" until the next page load.
    apiGet<AuthUser>('/api/auth/me')
      .then((fresh) => { setUser(fresh); setStoredSession(token, fresh); })
      .catch(() => { /* the session is valid either way; we just have less to show */ });
  }, []);

  const logout = useCallback(async () => {
    try { await apiPost('/api/auth/logout'); } catch { /* signing out locally still matters */ }
    clearStoredSession();
    try { localStorage.removeItem(BRANCH_KEY); } catch { /* ignore */ }
    setUser(null);
    setBranches([]);
    setActiveBranch(null);
    router.replace('/login');
  }, [router]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    });
  }, []);

  const setActiveBranchId = useCallback((id: string | null) => {
    // A branch user cannot switch context. The server would refuse anyway, but
    // offering the control and then ignoring it would be worse than not offering it.
    if (!user || user.role !== 'OWNER_ADMIN') return;
    setActiveBranch(id);
    try {
      if (id) localStorage.setItem(BRANCH_KEY, id); else localStorage.removeItem(BRANCH_KEY);
    } catch { /* ignore */ }
  }, [user]);

  const can = useCallback((permission: string) => canAccess(user?.role, permission), [user]);

  const meta = user ? ROLE_META[user.role] : { label: 'Guest', labelHi: 'अतिथि', color: '#6b7280' };
  const activeBranchName = activeBranchId
    ? (branches.find((b) => b.branch_id === activeBranchId)?.name ?? user?.branch_name ?? '')
    : 'All branches';

  const value = useMemo<AuthContextType>(() => ({
    user,
    isAuthenticated: Boolean(user),
    isLoading,
    branches,
    activeBranchId,
    activeBranchName,
    setActiveBranchId,
    login,
    logout,
    can,
    roleLabel: meta.label,
    roleColor: meta.color,
  }), [user, isLoading, branches, activeBranchId, activeBranchName, setActiveBranchId, login, logout, can, meta.label, meta.color]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
