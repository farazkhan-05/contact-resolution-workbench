import { useState, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from './AuthProvider';
import './AuthScreen.css';
import { ProductLogo } from '../components/layout/ProductLogo';

export function AuthScreen(): ReactNode {
  const { signIn, signUp, resetPassword, continueAsDemo, retryBootstrap, signOutUser, error, authenticated, accountCreated, operation } = useAuth();
  const [mode, setMode] = useState<'sign_in' | 'sign_up' | 'reset_password'>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
  return <main className="auth-page">
    <div className="auth-layout">
      <header className="auth-brand"><ProductLogo className="auth-brand-icon" />Contact Resolution Workbench</header>
      <section className="auth-introduction" aria-labelledby="auth-product-heading">
        <h1 id="auth-product-heading">Resolve identity conflicts without unsafe automatic merges.</h1>
        <p className="auth-product-copy">Compare fragmented records, surface contradictions, and route uncertain cases to human review.</p>
        <figure className="auth-example" aria-label="Identity resolution example using synthetic data">
          <figcaption><span>Resolution example</span><span className="auth-synthetic-note">Synthetic data</span></figcaption>
          <div className="auth-records">
            <div className="auth-record"><p className="auth-small-label">Incoming record</p><p className="auth-record-name">Arthur James<br />{' '}Pendelton Jr.</p></div>
            <div className="auth-record"><p className="auth-small-label">Candidate</p><p className="auth-record-name">Arthur James<br />{' '}Pendelton Sr.</p></div>
          </div>
          <p className="auth-similarity">Strong name similarity</p>
          <div className="auth-resolution"><p className="auth-conflict">Suffix conflict</p><span className="auth-review-state">Needs review</span></div>
        </figure>
      </section>
      <section className="auth-interface" aria-labelledby="auth-form-heading">
        <form onSubmit={mode === 'reset_password' ? submitReset : submit}>
          <h2 id="auth-form-heading">{authenticated ? 'Workspace setup' : mode === 'reset_password' ? 'Reset your password' : mode === 'sign_up' ? 'Create your account' : 'Sign in to your workspace'}</h2>
          {authenticated ? <>
            <p className="auth-subtitle">{accountCreated ? 'Your account was created, but the workspace could not be initialized.' : 'You are signed in, but the workspace could not be initialized.'}</p>
            {error && <p role="alert" className="auth-error">{error}</p>}
            <button type="button" disabled={pending} onClick={() => void retryBootstrap()} className="auth-button auth-primary">Retry</button>
            <button type="button" disabled={pending} onClick={() => void signOutUser()} className="auth-link auth-back">{operation === 'sign_out' ? 'Signing out…' : 'Sign out'}</button>
          </> : <>
            {mode === 'reset_password' ? <>
              <p className="auth-subtitle">Enter your email to request a reset link.</p>
              {resetSent ? <>
                <p role="status" className="auth-reset-status">If an account exists for that email, a password reset link has been sent.</p>
                <button type="button" onClick={backToSignIn} className="auth-link auth-back">Back to sign in</button>
              </> : <>
                <div className="auth-field"><label htmlFor="auth-email">Email</label><input id="auth-email" required disabled={pending} type="email" autoComplete="email" placeholder="Enter your email" value={email} onChange={(event) => setEmail(event.target.value)} /></div>
                {resetError && <p role="alert" className="auth-error">{resetError}</p>}
                <button disabled={pending} className="auth-button auth-primary">{pending ? 'Sending reset link…' : 'Send reset link'}</button>
                <button type="button" disabled={pending} onClick={backToSignIn} className="auth-link auth-back">Back to sign in</button>
              </>}
            </> : <>
              <p className="auth-subtitle">{mode === 'sign_in' ? 'Continue to Contact Resolution Workbench' : 'Set up your workspace to start resolving records.'}</p>
              <div className="auth-field"><label htmlFor="auth-email">Email</label><input id="auth-email" required disabled={pending} type="email" autoComplete="email" placeholder="Enter your email" value={email} onChange={(event) => setEmail(event.target.value)} /></div>
              <div className="auth-field">
                <div className="auth-password-label"><label htmlFor="auth-password">Password</label>{mode === 'sign_in' && <button type="button" disabled={pending} onClick={() => { setMode('reset_password'); setResetSent(false); setResetError(null); }} className="auth-link">Forgot password?</button>}</div>
                <div className="auth-password-input"><input id="auth-password" required disabled={pending} minLength={6} autoComplete={mode === 'sign_in' ? 'current-password' : 'new-password'} type={showPassword ? 'text' : 'password'} placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} /><button type="button" disabled={pending} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)} className="auth-password-toggle">{showPassword ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}</button></div>
              </div>
              {error && <p role="alert" className="auth-error">{error}</p>}
              <button disabled={pending} className="auth-button auth-primary">{operation === 'sign_up' ? 'Creating account…' : operation === 'sign_in' ? 'Signing in…' : mode === 'sign_in' ? 'Sign in' : 'Create account'}</button>
              <p className="auth-switch">{mode === 'sign_in' ? 'New to the workbench?' : 'Already have an account?'}{' '}<button type="button" disabled={pending} onClick={() => { setMode(mode === 'sign_in' ? 'sign_up' : 'sign_in'); setShowPassword(false); }} className="auth-link">{mode === 'sign_in' ? 'Create account' : 'Back to sign in'}</button></p>
              <div className="auth-divider"><span>or</span></div>
              <button type="button" onClick={() => void continueAsDemo()} disabled={pending} className="auth-button auth-demo">{operation === 'demo' ? 'Signing in…' : 'Explore demo workspace'}</button>
              <p className="auth-demo-copy">No account required</p>
            </>}
          </>}
        </form>
      </section>
    </div>
  </main>;
}
