import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, onAuthStateChanged, sendPasswordResetEmail, signInAnonymously, signInWithEmailAndPassword, signOut, type Auth, type User, type UserCredential } from 'firebase/auth';
import { api, clearAuthenticatedApiSession, setAuthenticatedApiSession, type WorkspaceSummary } from '../api/client';
import { bootstrapErrorMessage, firebaseErrorMessage, passwordResetErrorMessage } from './errors';

type AuthStatus = 'loading' | 'signed_out' | 'bootstrapping' | 'ready' | 'error';
type AuthOperation = 'sign_in' | 'sign_up' | 'demo' | 'sign_out' | 'password_reset' | null;
type AuthContextValue = {
  status: AuthStatus; workspace: WorkspaceSummary | null; error: string | null;
  authenticated: boolean; accountCreated: boolean; operation: AuthOperation;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  resetPassword: (email: string) => Promise<string | null>;
  continueAsDemo: () => Promise<void>; signOutUser: () => Promise<void>;
  retryBootstrap: () => Promise<void>;
};
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
  const [authenticated, setAuthenticated] = useState(false);
  const [accountCreated, setAccountCreated] = useState(false);
  const [operation, setOperation] = useState<AuthOperation>(null);
  const currentUser = useRef<User | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const busy = useRef<AuthOperation>(null);
  const pending = useRef<{ generation: number; promise: Promise<void> } | null>(null);

  const changeUser = useCallback((user: User | null) => {
    if (currentUser.current?.uid !== user?.uid) {
      generation.current += 1;
      pending.current = null;
      clearAuthenticatedApiSession();
      setWorkspace(null);
      setError(null);
      setAccountCreated(false);
    }
    currentUser.current = user;
    setAuthenticated(user !== null);
  }, []);

  const bootstrapApplicationSession = useCallback((user: User): Promise<void> => {
    if (!mounted.current || getFirebaseAuth().currentUser?.uid !== user.uid) return Promise.resolve();
    changeUser(user);
    const requestGeneration = generation.current;
    if (pending.current?.generation === requestGeneration) return pending.current.promise;
    const isCurrent = () => mounted.current && generation.current === requestGeneration && currentUser.current?.uid === user.uid;
    setStatus('bootstrapping');
    setWorkspace(null);
    setError(null);
    clearAuthenticatedApiSession();
    const promise = (async () => {
      try {
        // Bind this request to its user rather than the mutable shared API session.
        const bootstrap = await api.bootstrap(() => user.getIdToken());
        const initialWorkspace = bootstrap.workspaces[0];
        if (!initialWorkspace) throw new Error('Workspace missing');
        if (!isCurrent()) return;
        setAuthenticatedApiSession(() => user.getIdToken(), initialWorkspace.id);
        setWorkspace(initialWorkspace);
        setStatus('ready');
      } catch (err) {
        if (!isCurrent()) return;
        setError(bootstrapErrorMessage(err));
        setStatus('error');
      } finally {
        if (isCurrent()) pending.current = null;
      }
    })();
    pending.current = { generation: requestGeneration, promise };
    return promise;
  }, [changeUser]);

  useEffect(() => {
    mounted.current = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), (user) => {
        if (!mounted.current || getFirebaseAuth().currentUser?.uid !== user?.uid) return;
        // A delayed notification for the same user must not retry a completed
        // failed attempt. Sign-in and Retry explicitly own same-user recovery.
        if (user && currentUser.current?.uid === user.uid) return;
        changeUser(user);
        if (!user) { setStatus('signed_out'); return; }
        // The explicit Firebase operation owns bootstrap until its credential
        // resolves. A fast callback failure must not cause a hidden second attempt.
        if (busy.current && busy.current !== 'sign_out') {
          setStatus('bootstrapping');
          return;
        }
        void bootstrapApplicationSession(user);
      });
    } catch {
      setError('Authentication is unavailable. Please reload and try again.');
      setStatus('error');
    }
    return () => {
      mounted.current = false;
      generation.current += 1;
      pending.current = null;
      currentUser.current = null;
      clearAuthenticatedApiSession();
      unsubscribe?.();
    };
  }, [bootstrapApplicationSession, changeUser]);

  const authenticate = useCallback(async (kind: Exclude<AuthOperation, 'sign_out' | null>, callback: (auth: Auth) => Promise<UserCredential>) => {
    if (busy.current || pending.current) return;
    busy.current = kind;
    const actionGeneration = generation.current;
    setOperation(kind);
    setError(null);
    try {
      const auth = getFirebaseAuth();
      const credential = await callback(auth);
      if (!mounted.current || auth.currentUser?.uid !== credential.user.uid) return;
      changeUser(credential.user);
      setAccountCreated(kind === 'sign_up');
      // Explicit even for same-UID sign-in: Firebase need not emit a callback.
      await bootstrapApplicationSession(credential.user);
    } catch (err) {
      if (mounted.current && generation.current === actionGeneration) setError(firebaseErrorMessage(err));
    } finally {
      busy.current = null;
      if (mounted.current) setOperation(null);
    }
  }, [bootstrapApplicationSession, changeUser]);

  const retryBootstrap = useCallback(async () => {
    if (busy.current) return;
    const user = getFirebaseAuth().currentUser;
    if (user) await bootstrapApplicationSession(user);
  }, [bootstrapApplicationSession]);

  const resetPassword = useCallback(async (email: string): Promise<string | null> => {
    if (busy.current) return 'Please wait and try again.';
    busy.current = 'password_reset';
    setOperation('password_reset');
    setError(null);
    try {
      await sendPasswordResetEmail(getFirebaseAuth(), email);
      return null;
    } catch (err) {
      return passwordResetErrorMessage(err);
    } finally {
      busy.current = null;
      if (mounted.current) setOperation(null);
    }
  }, []);

  const signOutUser = useCallback(async () => {
    if (busy.current) return;
    busy.current = 'sign_out';
    setOperation('sign_out');
    // Invalidate outstanding bootstrap before awaiting Firebase sign-out.
    generation.current += 1;
    pending.current = null;
    clearAuthenticatedApiSession();
    setWorkspace(null);
    try {
      await signOut(getFirebaseAuth());
      if (mounted.current) { changeUser(null); setStatus('signed_out'); }
    } catch {
      if (mounted.current) { setError('Could not sign out. Please try again.'); setStatus('error'); }
    } finally {
      busy.current = null;
      if (mounted.current) setOperation(null);
    }
  }, [changeUser]);

  const value = useMemo<AuthContextValue>(() => ({
    status, workspace, error, authenticated, accountCreated, operation, retryBootstrap, signOutUser, resetPassword,
    signIn: (email, password) => authenticate('sign_in', (auth) => signInWithEmailAndPassword(auth, email, password)),
    signUp: (email, password) => authenticate('sign_up', (auth) => createUserWithEmailAndPassword(auth, email, password)),
    continueAsDemo: () => authenticate('demo', signInAnonymously),
  }), [status, workspace, error, authenticated, accountCreated, operation, retryBootstrap, signOutUser, resetPassword, authenticate]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue { const value = useContext(AuthContext); if (!value) throw new Error('useAuth must be used inside AuthProvider'); return value; }
