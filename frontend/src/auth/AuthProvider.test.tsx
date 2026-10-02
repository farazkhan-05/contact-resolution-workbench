import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { AuthProvider, useAuth } from './AuthProvider';
import { App } from '../App';
import { ApiError, api } from '../api/client';
import { bootstrapErrorMessage, firebaseErrorMessage } from './errors';

const firebase = vi.hoisted(() => ({
  auth: { currentUser: null as User | null },
  listener: null as ((user: User | null) => void) | null,
  signUp: vi.fn(), signIn: vi.fn(), demo: vi.fn(), signOut: vi.fn(),
}));
vi.mock('firebase/app', () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock('firebase/auth', () => ({
  getAuth: () => firebase.auth,
  onAuthStateChanged: (_auth: unknown, callback: (user: User | null) => void) => {
    firebase.listener = callback;
    callback(firebase.auth.currentUser);
    return () => { firebase.listener = null; };
  },
  createUserWithEmailAndPassword: firebase.signUp,
  signInWithEmailAndPassword: firebase.signIn,
  signInAnonymously: firebase.demo,
  signOut: firebase.signOut,
}));
vi.mock('../api/client', async (original) => {
  const actual = await original<typeof import('../api/client')>();
  return { ...actual, api: { ...actual.api, bootstrap: vi.fn(), getCases: vi.fn(async () => []) } };
});
vi.mock('../api/telemetry', () => ({ recordUsageEvent: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const user = (uid: string) => ({ uid, getIdToken: vi.fn(async () => `synthetic-${uid}`) }) as unknown as User;
const result = (id = 'workspace-a') => ({ user: { id: 'internal', is_anonymous: false }, workspaces: [{ id, name: 'My workspace', role: 'OWNER' }] });
let session: ReturnType<typeof useAuth>;
function Probe() { session = useAuth(); return <output>{session.status}:{session.workspace?.id}</output>; }
function mount() { return render(<AuthProvider><Probe /><App /></AuthProvider>); }
function emit(value: User | null) { firebase.auth.currentUser = value; firebase.listener?.(value); }
async function createAccount() {
  fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'synthetic@example.invalid' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Synthetic-only-9!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
}

beforeEach(() => {
  firebase.auth.currentUser = null;
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'synthetic-config');
  vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'synthetic.invalid');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'synthetic');
  vi.stubEnv('VITE_FIREBASE_APP_ID', 'synthetic');
  vi.mocked(api.bootstrap).mockReset().mockResolvedValue(result());
  const authenticate = async () => { const value = firebase.auth.currentUser ?? user('a'); emit(value); return { user: value }; };
  firebase.signUp.mockReset().mockImplementation(authenticate);
  firebase.signIn.mockReset().mockImplementation(authenticate);
  firebase.signOut.mockReset().mockImplementation(async () => emit(null));
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('application session recovery', () => {
  it('restores the same Firebase session on remount and reuses its workspace', async () => {
    firebase.auth.currentUser = user('a');
    const first = mount();
    await screen.findByText('No cases yet');
    first.unmount();
    mount();
    await screen.findByText('No cases yet');
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
    expect(session.workspace?.id).toBe('workspace-a');
  });
  it('signup succeeds, deduplicates the overlapping callback and enters the workbench', async () => {
    const bootstrap = deferred<ReturnType<typeof result>>();
    vi.mocked(api.bootstrap).mockReturnValue(bootstrap.promise);
    mount();
    await createAccount();
    await screen.findByText('Starting your workspace…');
    expect(firebase.signUp).toHaveBeenCalledTimes(1);
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    await act(async () => bootstrap.resolve(result()));
    await screen.findByText('No cases yet');
    expect(session.authenticated).toBe(true);
  });

  it('signup partial success keeps Firebase authenticated; explicit retry loads the workbench', async () => {
    vi.mocked(api.bootstrap).mockRejectedValueOnce(new ApiError(500, 'private infrastructure detail'));
    mount();
    await createAccount();
    await screen.findByText('Your account was created, but the workspace could not be initialized.');
    expect(firebase.auth.currentUser).not.toBeNull();
    expect(session.authenticated).toBe(true);
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByText('private infrastructure detail')).toBeNull();
    const bootstrap = deferred<ReturnType<typeof result>>();
    vi.mocked(api.bootstrap).mockReturnValue(bootstrap.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Starting your workspace…');
    act(() => { void session.retryBootstrap(); });
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
    await act(async () => bootstrap.resolve(result()));
    await screen.findByText('No cases yet');
    expect(firebase.signUp).toHaveBeenCalledTimes(1);
  });

  it('same-UID sign-in retries after a failed restoration without any new auth callback', async () => {
    firebase.auth.currentUser = user('a');
    vi.mocked(api.bootstrap).mockRejectedValueOnce(new ApiError(503, 'private'));
    mount();
    await screen.findByText('You are signed in, but the workspace could not be initialized.');
    firebase.signIn.mockImplementation(async () => ({ user: firebase.auth.currentUser }));
    await act(async () => session.signIn('synthetic@example.invalid', 'synthetic'));
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
    await screen.findByText('No cases yet');
  });

  it('a delayed same-user callback cannot silently retry a failed signup bootstrap', async () => {
    firebase.signUp.mockImplementation(async () => {
      firebase.auth.currentUser = user('a');
      return { user: firebase.auth.currentUser };
    });
    vi.mocked(api.bootstrap).mockRejectedValueOnce(new ApiError(500, 'private'));
    mount();
    await createAccount();
    await screen.findByText('Your account was created, but the workspace could not be initialized.');
    act(() => firebase.listener?.(firebase.auth.currentUser));
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(session.status).toBe('error');
  });

  it('sign-in bootstrap failure also offers a direct retry', async () => {
    vi.mocked(api.bootstrap).mockRejectedValueOnce(new ApiError(401, 'private'));
    mount();
    await act(async () => session.signIn('synthetic@example.invalid', 'synthetic'));
    await screen.findByText('You are signed in, but the workspace could not be initialized.');
    expect(screen.getByRole('alert').textContent).toContain('could not verify your session');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('No cases yet');
    expect(firebase.signIn).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('stale bootstrap %s cannot overwrite a newer ready session or API headers', async (outcome) => {
    const stale = deferred<ReturnType<typeof result>>();
    vi.mocked(api.bootstrap).mockReturnValueOnce(stale.promise);
    mount();
    act(() => emit(user('a')));
    act(() => emit(user('b')));
    await screen.findByText('No cases yet');
    await act(async () => {
      if (outcome === 'resolve') stale.resolve(result('stale-workspace'));
      else stale.reject(new ApiError(500, 'private'));
    });
    expect(session.status).toBe('ready');
    expect(session.workspace?.id).toBe('workspace-a');
    expect(session.error).toBeNull();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'));
    await api.listSources();
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer synthetic-b');
    expect(headers.get('X-Workspace-ID')).toBe('workspace-a');
    fetchMock.mockRestore();
  });

  it('stale success cannot replace a newer error, or mark a signed-out session ready', async () => {
    const stale = deferred<ReturnType<typeof result>>();
    vi.mocked(api.bootstrap).mockReturnValueOnce(stale.promise).mockRejectedValueOnce(new ApiError(500, 'private'));
    mount();
    act(() => emit(user('a')));
    act(() => emit(user('b')));
    await screen.findByText('You are signed in, but the workspace could not be initialized.');
    await act(async () => stale.resolve(result('stale')));
    expect(session.status).toBe('error');
    expect(session.workspace).toBeNull();
    const next = deferred<ReturnType<typeof result>>();
    vi.mocked(api.bootstrap).mockReturnValueOnce(next.promise);
    act(() => { void session.retryBootstrap(); });
    act(() => emit(null));
    await act(async () => next.resolve(result()));
    expect(session.status).toBe('signed_out');
  });

  it.each(['sign_up', 'sign_in'] as const)('blocks duplicate %s submissions and displays Firebase working state', async (kind) => {
    const credential = deferred<{ user: User }>();
    (kind === 'sign_up' ? firebase.signUp : firebase.signIn).mockReturnValue(credential.promise);
    mount();
    if (kind === 'sign_up') await createAccount();
    else act(() => { void session.signIn('synthetic@example.invalid', 'synthetic'); });
    const label = kind === 'sign_up' ? 'Creating account…' : 'Signing in…';
    expect((await screen.findByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      void session.signUp('synthetic@example.invalid', 'synthetic');
      void session.signIn('synthetic@example.invalid', 'synthetic');
    });
    expect(firebase.signUp.mock.calls.length + firebase.signIn.mock.calls.length).toBe(1);
    await act(async () => { const value = user('a'); emit(value); credential.resolve({ user: value }); });
    await screen.findByText('No cases yet');
  });

  it('maps Firebase errors in the rendered UI', async () => {
    firebase.signUp.mockRejectedValue({ code: 'auth/email-already-in-use', message: 'raw SDK message' });
    mount(); await createAccount();
    expect((await screen.findByRole('alert')).textContent).toBe('An account already exists with this email. Sign in to continue.');
    expect(session.authenticated).toBe(false);
  });
});

describe('safe error mapping', () => {
  it.each([
    ['auth/email-already-in-use', 'An account already exists'],
    ['auth/invalid-email', 'Enter a valid email'],
    ['auth/weak-password', 'Choose a password'],
    ['auth/invalid-credential', 'email or password is incorrect'],
    ['auth/wrong-password', 'email or password is incorrect'],
    ['auth/user-not-found', 'email or password is incorrect'],
    ['auth/network-request-failed', 'Check your connection'],
    ['unknown', 'Authentication could not be completed'],
  ])('maps %s without SDK details', (code, expected) => {
    expect(firebaseErrorMessage({ code, message: 'private SDK detail' })).toContain(expected);
    expect(firebaseErrorMessage({ code, message: 'private SDK detail' })).not.toContain('private');
  });
  it.each([401, 403, 422, 500, 503])('maps backend %s without infrastructure details', (status) => {
    expect(bootstrapErrorMessage(new ApiError(status, 'private infrastructure detail'))).not.toContain('private');
  });
  it('maps transport failure', () => expect(bootstrapErrorMessage(new TypeError('private'))).toContain('Check your connection'));
});
