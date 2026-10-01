import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useSWRConfig } from 'swr';
import {
  apiGet, apiPost, clearStoredSession, readStoredSession, setActiveBranchHeader, setStoredSession,
  setUnauthorizedHandler,
} from './api';
import { canAccess, ROLE_META, type UserRole } from './rbac';

export interface AuthUser {
  user_id: string;
  role: UserRole;
  branch_id: string | null;      // home branch; null only for OWNER_ADMIN (chain-wide)
  branch_name?: string | null;
  full_name: string;
  email?: string | null;
  phone?: string | null;
  language_pref?: 'en' | 'hi';
  must_change_password?: boolean;
}

export interface Branch {
  branch_id: string; name: string; code?: string; address?: string | null;
  state?: string | null; state_code?: string; gstin?: string | null; phone?: string | null;
  is_home?: boolean;
}

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  /** True until the stored session has been checked — pages must not redirect
   *  before this is false, or a hard refresh bounces a signed-in user to /login. */
  isLoading: boolean;
  /** The branches this user may act at (server-authorised). */
  branches: Branch[];
  /**
   * The branch currently being viewed and transacted at. `null` is "All branches",
   * which only an Owner can choose and which is never a place a sale can happen.
   */
  activeBranchId: string | null;
  activeBranchName: string;
  activeBranch: Branch | null;
  /** Owner on "All branches": a physical transaction needs a branch picked first. */
  needsBranchForTransaction: boolean;
  /** Whether this user has more than one branch to choose between. */
  canSwitchBranch: boolean;
  setActiveBranchId: (id: string | null) => void;
  login: (token: string, user: AuthUser) => void;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
  roleLabel: string;
  roleColor: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const BRANCH_KEY = 'erp_active_branch';

function savedBranch(): string | null {
  try { return localStorage.getItem(BRANCH_KEY); } catch { return null; }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [activeBranchId, setActiveBranch] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);

  /** Chooses the starting branch once the authorised list is known. */
  const pickInitialBranch = useCallback((u: AuthUser, list: Branch[]) => {
    const saved = savedBranch();
    const allowed = new Set(list.map((b) => b.branch_id));
    let pick: string | null;
    if (u.role === 'OWNER_ADMIN') {
      // An owner with a single branch has nothing to choose: that branch it is.
      pick = saved && allowed.has(saved) ? saved : list.length === 1 ? list[0].branch_id : null;
    } else {
      pick = saved && allowed.has(saved) ? saved : (u.branch_id ?? list[0]?.branch_id ?? null);
    }
    setActiveBranchHeader(pick);
    setActiveBranch(pick);
  }, []);

  // Restore, then confirm with the server. A token in localStorage proves nothing
  // — it may have expired or been revoked — so /me is the source of truth.
  useEffect(() => {
    const stored = readStoredSession<AuthUser>();
    if (!stored) { setLoading(false); return; }
    setUser(stored.user);
    // Until the authorised list arrives, act at the home branch: never "all".
    setActiveBranchHeader(stored.user.role === 'OWNER_ADMIN' ? null : stored.user.branch_id);
    Promise.all([apiGet<AuthUser>('/api/auth/me'), apiGet<Branch[]>('/api/auth/branches')])
      .then(([fresh, list]) => {
        setUser(fresh);
        setStoredSession(stored.token, fresh);
        setBranches(list);
        pickInitialBranch(fresh, list);
      })
      .catch(() => { clearStoredSession(); setUser(null); setActiveBranchHeader(null); })
      .finally(() => setLoading(false));
  }, [pickInitialBranch]);

  const login = useCallback((token: string, u: AuthUser) => {
    setStoredSession(token, u);
    setUser(u);
    setActiveBranchHeader(u.role === 'OWNER_ADMIN' ? null : u.branch_id);
    setActiveBranch(u.role === 'OWNER_ADMIN' ? null : u.branch_id);
    setLoading(false);
    // The login response carries the claims the server was willing to issue; /me
    // adds the display details (branch name, language) the UI needs.
    Promise.all([apiGet<AuthUser>('/api/auth/me'), apiGet<Branch[]>('/api/auth/branches')])
      .then(([fresh, list]) => {
        setUser(fresh); setStoredSession(token, fresh);
        setBranches(list); pickInitialBranch(fresh, list);
      })
      .catch(() => { /* the session is valid either way; we just have less to show */ });
  }, [pickInitialBranch]);

  const logout = useCallback(async () => {
    try { await apiPost('/api/auth/logout'); } catch { /* signing out locally still matters */ }
    clearStoredSession();
    try { localStorage.removeItem(BRANCH_KEY); } catch { /* ignore */ }
    setActiveBranchHeader(null);
    setUser(null);
    setBranches([]);
    setActiveBranch(null);
    // Nothing from this session may be shown to whoever signs in next.
    void mutate(() => true, undefined, { revalidate: false });
    router.replace('/login');
  }, [router, mutate]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setActiveBranchHeader(null);
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    });
  }, []);

  const setActiveBranchId = useCallback((id: string | null) => {
    if (!user) return;
    if (id === null && user.role !== 'OWNER_ADMIN') return;          // only an owner may view "all"
    if (id !== null && !branches.some((b) => b.branch_id === id)) return; // never a branch they lack
    setActiveBranchHeader(id);
    setActiveBranch(id);
    try {
      if (id) localStorage.setItem(BRANCH_KEY, id); else localStorage.removeItem(BRANCH_KEY);
    } catch { /* ignore */ }
    // Every cached list was fetched for the previous branch; refetch them all.
    void mutate(() => true);
  }, [user, branches, mutate]);

  const can = useCallback((permission: string) => canAccess(user?.role, permission), [user]);

  const meta = user ? ROLE_META[user.role] : { label: 'Guest', labelHi: 'अतिथि', color: '#6b7280' };
  const activeBranch = branches.find((b) => b.branch_id === activeBranchId) ?? null;
  const activeBranchName = activeBranchId
    ? (activeBranch?.name ?? user?.branch_name ?? '')
    : 'All branches';

  const value = useMemo<AuthContextType>(() => ({
    user,
    isAuthenticated: Boolean(user),
    isLoading,
    branches,
    activeBranchId,
    activeBranchName,
    activeBranch,
    needsBranchForTransaction: Boolean(user && user.role === 'OWNER_ADMIN' && !activeBranchId),
    canSwitchBranch: branches.length > 1,
    setActiveBranchId,
    login,
    logout,
    can,
    roleLabel: meta.label,
    roleColor: meta.color,
  }), [user, isLoading, branches, activeBranchId, activeBranchName, activeBranch, setActiveBranchId, login, logout, can, meta.label, meta.color]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
