import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { api, clearAuthenticatedApiSession, setAuthenticatedApiSession, type WorkspaceSummary } from '../api/client';

type AuthStatus = 'loading' | 'signed_out' | 'bootstrapping' | 'ready' | 'error';
type AuthContextValue = { status: AuthStatus; workspace: WorkspaceSummary | null; error: string | null; signIn: (email: string, password: string) => Promise<void>; signUp: (email: string, password: string) => Promise<void>; continueAsDemo: () => Promise<void>; signOutUser: () => Promise<void>; };
const AuthContext = createContext<AuthContextValue | null>(null);
let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;

function getFirebaseAuth(): Auth {
  if (firebaseAuth) return firebaseAuth;
  const config = { apiKey: import.meta.env.VITE_FIREBASE_API_KEY, authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID, appId: import.meta.env.VITE_FIREBASE_APP_ID };
  if (Object.values(config).some((value) => !value)) throw new Error('Firebase is not configured for this environment.');
  firebaseApp = initializeApp(config);
  firebaseAuth = getAuth(firebaseApp);
  return firebaseAuth;
}

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    try {
      const unsubscribe = onAuthStateChanged(getFirebaseAuth(), async (user) => {
        clearAuthenticatedApiSession(); setWorkspace(null);
        if (!user) { if (active) setStatus('signed_out'); return; }
        if (active) setStatus('bootstrapping');
        try {
          setAuthenticatedApiSession(() => user.getIdToken(), 'bootstrap');
          const bootstrap = await api.bootstrap();
          const initialWorkspace = bootstrap.workspaces[0];
          if (!initialWorkspace) throw new Error('No workspace was provisioned for this account.');
          setAuthenticatedApiSession(() => user.getIdToken(), initialWorkspace.id);
          if (active) { setWorkspace(initialWorkspace); setError(null); setStatus('ready'); }
        } catch (err) {
          clearAuthenticatedApiSession();
          if (active) { setError(err instanceof Error ? err.message : 'Could not start your workspace session.'); setStatus('error'); }
        }
      });
      return () => { active = false; unsubscribe(); };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Firebase could not be initialized.'); setStatus('error');
    }
    return () => { active = false; };
  }, []);
  const action = async (callback: (auth: Auth) => Promise<unknown>): Promise<void> => { setError(null); try { await callback(getFirebaseAuth()); } catch (err) { setError(err instanceof Error ? err.message : 'Authentication failed.'); throw err; } };
  const value = useMemo<AuthContextValue>(() => ({ status, workspace, error, signIn: (email, password) => action((auth) => signInWithEmailAndPassword(auth, email, password)), signUp: (email, password) => action((auth) => createUserWithEmailAndPassword(auth, email, password)), continueAsDemo: () => action((auth) => signInAnonymously(auth)), signOutUser: async () => { clearAuthenticatedApiSession(); await signOut(getFirebaseAuth()); } }), [status, workspace, error]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue { const value = useContext(AuthContext); if (!value) throw new Error('useAuth must be used inside AuthProvider'); return value; }
