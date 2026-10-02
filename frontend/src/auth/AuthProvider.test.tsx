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
  signUp: vi.fn(), signIn: vi.fn(), demo: vi.fn(), signOut: vi.fn(), resetPassword: vi.fn(),
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
  sendPasswordResetEmail: firebase.resetPassword,
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
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
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
  firebase.demo.mockReset().mockImplementation(authenticate);
  firebase.signOut.mockReset().mockImplementation(async () => emit(null));
  firebase.resetPassword.mockReset().mockResolvedValue(undefined);
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

describe('password reset', () => {
  async function openReset() {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    return screen.findByRole('button', { name: 'Send reset link' });
  }

  it('shows Forgot Password on Sign In and opens the reset form', async () => {
    mount();
    expect(screen.getByRole('button', { name: 'Forgot password?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('sends a valid email directly through Firebase and shows a neutral success message', async () => {
    await openReset();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'synthetic@example.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('If an account exists for that email, a password reset link has been sent.')).toBeTruthy();
    expect(firebase.resetPassword).toHaveBeenCalledTimes(1);
    expect(firebase.resetPassword.mock.calls[0][1]).toBe('synthetic@example.invalid');
    expect(screen.queryByText(/account was not found|no account exists/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeTruthy();
  });

  it('shows loading and blocks duplicate reset requests', async () => {
    const request = deferred<void>();
    firebase.resetPassword.mockReturnValue(request.promise);
    await openReset();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'synthetic@example.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    const pending = await screen.findByRole('button', { name: 'Sending reset link…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(firebase.resetPassword).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve());
    expect(await screen.findByText('If an account exists for that email, a password reset link has been sent.')).toBeTruthy();
  });

  it.each([
    ['auth/invalid-email', 'Enter a valid email address.'],
    ['auth/network-request-failed', 'Could not connect. Check your connection and try again.'],
    ['auth/too-many-requests', 'Too many attempts. Please wait and try again.'],
    ['auth/internal-error', 'The reset request could not be completed. Please try again.'],
  ])('maps %s safely', async (code, message) => {
    firebase.resetPassword.mockRejectedValue({ code, message: 'private SDK detail' });
    await openReset();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'synthetic@example.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.queryByText(/private SDK detail/)).toBeNull();
  });

  it('treats a Firebase account-existence error as a neutral success', async () => {
    firebase.resetPassword.mockRejectedValue({ code: 'auth/user-not-found', message: 'private SDK detail' });
    await openReset();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'synthetic@example.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('If an account exists for that email, a password reset link has been sent.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('returns to Sign In from reset state', async () => {
    await openReset();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('authentication input controls', () => {
  it('renders product identity and associates Forgot Password with the password label', () => {
    mount();
    expect(screen.getByText('Identity Resolution Workbench')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign in to your workspace' })).toBeTruthy();
    expect(screen.getByText('Continue to Identity Resolution Workbench')).toBeTruthy();
    expect(screen.getByText('Resolution example')).toBeTruthy();
    expect(screen.getByText('Synthetic data')).toBeTruthy();
    expect(screen.getByRole('table').querySelectorAll('tr')).toHaveLength(5);
    expect(screen.getAllByText('Arthur James Pendelton', { selector: 'td' })).toHaveLength(2);
    expect(screen.getByText('Different generational suffixes require manual review.')).toBeTruthy();
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(screen.getByText('IR')).toBeTruthy();
    const forgot = screen.getByRole('button', { name: 'Forgot password?' });
    expect(forgot.parentElement?.querySelector('label')?.htmlFor).toBe('auth-password');
    expect((screen.getByLabelText('Email') as HTMLInputElement).autocomplete).toBe('email');
    expect((screen.getByLabelText('Password') as HTMLInputElement).autocomplete).toBe('current-password');
  });

  it('submits the same credentials through the existing sign-in action', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'synthetic@example.invalid' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Synthetic-only-9!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('No cases yet');
    expect(firebase.signIn).toHaveBeenCalledWith(firebase.auth, 'synthetic@example.invalid', 'Synthetic-only-9!');
    expect(firebase.signUp).not.toHaveBeenCalled();
  });

  it('explores the demo through the existing anonymous Firebase action', async () => {
    mount();
    expect(screen.getByText('No account required')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Explore demo workspace' }));
    await screen.findByText('No cases yet');
    expect(firebase.demo).toHaveBeenCalledWith(firebase.auth);
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(firebase.signIn).not.toHaveBeenCalled();
    expect(firebase.signUp).not.toHaveBeenCalled();
  });

  it('uses the email placeholder and provides a keyboard-accessible password visibility toggle', () => {
    mount();
    const emailInput = screen.getByLabelText('Email') as HTMLInputElement;
    const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;
    expect(emailInput.placeholder).toBe('Enter your email');
    expect(passwordInput.placeholder).toBe('Enter your password');
    expect(passwordInput.type).toBe('password');

    const showButton = screen.getByRole('button', { name: 'Show password' }) as HTMLButtonElement;
    expect(showButton.tagName).toBe('BUTTON');
    expect(showButton.type).toBe('button');
    expect(showButton.tabIndex).toBe(0);
    fireEvent.click(showButton);
    expect(passwordInput.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(passwordInput.type).toBe('password');
  });

  it('keeps the password toggle in Create Account and omits it from Forgot Password', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeTruthy();
    expect(screen.getByText('Set up your workspace to start resolving records.')).toBeTruthy();
    expect((screen.getByLabelText('Password') as HTMLInputElement).autocomplete).toBe('new-password');
    expect((screen.getByLabelText('Email') as HTMLInputElement).placeholder).toBe('Enter your email');
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect((screen.getByLabelText('Email') as HTMLInputElement).placeholder).toBe('Enter your email');
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show password' })).toBeNull();
  });
});
