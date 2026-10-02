import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from './AuthProvider';

export function AuthScreen(): ReactNode {
  const { signIn, signUp, resetPassword, continueAsDemo, retryBootstrap, signOutUser, error, authenticated, accountCreated, operation } = useAuth();
  const [mode, setMode] = useState<'sign_in' | 'sign_up' | 'reset_password'>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const pending = operation !== null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    void (mode === 'sign_in' ? signIn(email, password) : signUp(email, password));
  };
  const submitReset = (event: FormEvent) => {
    event.preventDefault();
    if (pending || resetSent) return;
    setResetError(null);
    void resetPassword(email).then((message) => {
      if (message) setResetError(message);
      else setResetSent(true);
    });
  };
  const backToSignIn = () => {
    setMode('sign_in');
    setResetSent(false);
    setResetError(null);
  };
  return <main className="flex min-h-screen items-center justify-center bg-background p-4">
    <form onSubmit={mode === 'reset_password' ? submitReset : submit} className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
      <h1 className="text-lg font-semibold text-foreground">Contact Resolution Workbench</h1>
      {authenticated ? <>
        <p className="mt-3 text-sm text-foreground">{accountCreated ? 'Your account was created, but the workspace could not be initialized.' : 'You are signed in, but the workspace could not be initialized.'}</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
        <button type="button" disabled={pending} onClick={() => void retryBootstrap()} className="mt-5 w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Retry</button>
        <button type="button" disabled={pending} onClick={() => void signOutUser()} className="mt-3 w-full text-sm text-accent">{operation === 'sign_out' ? 'Signing out…' : 'Sign out'}</button>
      </> : <>
        {mode === 'reset_password' ? <>
          <p className="mt-2 text-sm text-muted">Reset your password</p>
          {resetSent ? <>
            <p role="status" className="mt-5 text-sm text-foreground">If an account exists for that email, a password reset link has been sent.</p>
            <button type="button" onClick={backToSignIn} className="mt-5 w-full text-sm text-accent">Back to sign in</button>
          </> : <>
            <label className="mt-5 block text-sm text-foreground">Email<input required disabled={pending} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded border border-border bg-background px-3 py-2" /></label>
            {resetError && <p role="alert" className="mt-3 text-sm text-red-600">{resetError}</p>}
            <button disabled={pending} className="mt-5 w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{pending ? 'Sending reset link…' : 'Send reset link'}</button>
            <button type="button" disabled={pending} onClick={backToSignIn} className="mt-3 w-full text-sm text-accent">Back to sign in</button>
          </>}
        </> : <>
        <p className="mt-2 text-sm text-muted">Sign in to use an isolated workspace.</p>
        <label className="mt-5 block text-sm text-foreground">Email<input required disabled={pending} type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded border border-border bg-background px-3 py-2" /></label>
        <label className="mt-3 block text-sm text-foreground">Password<input required disabled={pending} minLength={6} type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded border border-border bg-background px-3 py-2" /></label>
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
        <button disabled={pending} className="mt-5 w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{operation === 'sign_up' ? 'Creating account…' : operation === 'sign_in' ? 'Signing in…' : mode === 'sign_in' ? 'Sign in' : 'Create account'}</button>
        {mode === 'sign_in' && <button type="button" disabled={pending} onClick={() => { setMode('reset_password'); setResetSent(false); setResetError(null); }} className="mt-3 w-full text-sm text-accent">Forgot password?</button>}
        <button type="button" disabled={pending} onClick={() => setMode(mode === 'sign_in' ? 'sign_up' : 'sign_in')} className="mt-3 w-full text-sm text-accent">{mode === 'sign_in' ? 'Create an account' : 'Use an existing account'}</button>
        <div className="my-4 border-t border-border" />
        <button type="button" onClick={() => void continueAsDemo()} disabled={pending} className="w-full rounded border border-border px-3 py-2 text-sm text-foreground disabled:opacity-50">{operation === 'demo' ? 'Signing in…' : 'Continue with anonymous demo'}</button>
        </>}
      </>}
    </form>
  </main>;
}
