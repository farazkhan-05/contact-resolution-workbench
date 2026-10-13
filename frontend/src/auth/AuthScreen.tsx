import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { ProductLogo } from '../components/layout/ProductLogo';
import { Button } from '../components/ui/Button';
import { Field, TextInput } from '../components/ui/Field';
import { InlineFeedback, StatusIndicator } from '../components/ui/Feedback';
import './AuthScreen.css';

type AuthView = 'sign_in' | 'sign_up' | 'reset_password';

export function AuthScreen(): ReactNode {
  const { status, signIn, signUp, resetPassword, continueAsDemo, retryBootstrap, signOutUser, error, authenticated, accountCreated, operation } = useAuth();
  const [mode, setMode] = useState<AuthView>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const signingOut = operation === 'sign_out';
  const restoring = status === 'loading';
  const initializing = status === 'bootstrapping';
  const waiting = restoring || initializing || signingOut;
  const pending = operation !== null && operation !== undefined;
  const view = waiting ? signingOut ? 'sign_out' : status : authenticated ? 'recovery' : `${mode}:${resetSent}`;
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current !== view && previousView.current !== 'loading') headingRef.current?.focus();
    previousView.current = view;
  }, [view]);

  const switchView = (next: AuthView) => {
    setMode(next);
    setShowPassword(false);
    setResetSent(false);
    setResetError(null);
  };
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
  const visibleError = mode === 'reset_password' ? resetError : error;
  // Associate mapped validation failures without treating transport errors as invalid fields.
  const emailInvalid = !!visibleError && ['Enter a valid email address.', 'An account already exists with this email. Sign in to continue.', 'The email or password is incorrect.'].includes(visibleError);
  const passwordInvalid = !!visibleError && ['Choose a password with at least 6 characters.', 'The email or password is incorrect.'].includes(visibleError);
  const progress = operation === 'sign_up' ? 'Creating account…' : operation === 'demo' ? 'Opening demo workspace…' : operation === 'password_reset' ? 'Sending reset link…' : operation === 'sign_in' ? 'Signing in…' : '';
  const heading = waiting ? signingOut ? 'Signing out…' : restoring ? 'Restoring your session…' : 'Starting your workspace…' : authenticated ? 'Workspace setup' : mode === 'reset_password' ? 'Reset your password' : mode === 'sign_up' ? 'Create your account' : 'Welcome back';
  const errorFeedback = visibleError && <div id="auth-error" className="auth-error"><InlineFeedback tone="error">{visibleError}</InlineFeedback></div>;
  const emailField = <Field id="auth-email" label="Email">
    {(accessibility) => <TextInput {...accessibility} required disabled={pending} type="email" autoComplete="email" placeholder="Enter your email" value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={emailInvalid || undefined} aria-describedby={visibleError ? 'auth-error' : undefined} />}
  </Field>;

  return <main className="auth-page">
    <a className="auth-skip" href="#auth-form-heading">Skip to sign-in form</a>
    <header className="auth-brand"><ProductLogo className="auth-brand-icon" /><span>Contact Resolution Workbench</span></header>
    <div className="auth-layout">
      <section className="auth-introduction" aria-labelledby="auth-product-heading">
        <p className="auth-eyebrow">Clarity before a decision</p>
        <h1 id="auth-product-heading">Compare records.<br />Make a clear decision.</h1>
        <p className="auth-product-copy">Inspect potentially matching contact records, understand what matches and what conflicts, then make the final call.</p>
        <figure className="auth-example" aria-label="Identity resolution example using synthetic data">
          <figcaption><strong>A name is only the beginning.</strong><span>Synthetic example</span></figcaption>
          <div className="auth-records">
            <div className="auth-record"><p className="auth-small-label">Incoming record</p><p className="auth-record-name">Arthur James Pendelton Jr.</p><p className="auth-small-label">Northstar Research</p></div>
            <div className="auth-record"><p className="auth-small-label">Candidate record</p><p className="auth-record-name">Arthur James Pendelton Sr.</p><p className="auth-small-label">Northstar Research</p></div>
          </div>
          <div className="auth-resolution"><StatusIndicator tone="warning">Suffix conflict</StatusIndicator><p>Similar details. A suffix conflict.<br /><strong>Review the evidence before deciding.</strong></p></div>
        </figure>
        <p className="auth-footnote">System recommendations support your review.<br />They do not confirm an identity.</p>
      </section>
      <section className="auth-interface" aria-labelledby="auth-form-heading">
        <p className="auth-eyebrow">Your workspace</p>
        <h2 id="auth-form-heading" ref={headingRef} tabIndex={-1}>{heading}</h2>
        {waiting ? <div className="auth-waiting" role="status" aria-live="polite" aria-atomic="true">
          <span className="ui-spinner" aria-hidden="true" />
          <p>{signingOut ? 'Closing your session. Please wait.' : restoring ? 'Checking your existing session before opening the workbench.' : accountCreated ? 'Your account is created. Preparing your workspace before you can review cases.' : 'You are signed in. Preparing your workspace before you can review cases.'}</p>
        </div> : authenticated ? <>
          <p className="auth-subtitle">{accountCreated ? 'Your account was created, but the workspace could not be initialized.' : 'You are signed in, but the workspace could not be initialized.'}</p>
          {error && <div className="auth-error"><InlineFeedback tone="error">{error}</InlineFeedback></div>}
          <Button variant="primary" disabled={pending} onClick={() => void retryBootstrap()} className="auth-submit">Retry</Button>
          <Button variant="quiet" disabled={pending} onClick={() => void signOutUser()} className="auth-back">Sign out</Button>
        </> : <form onSubmit={mode === 'reset_password' ? submitReset : submit} aria-labelledby="auth-form-heading" aria-busy={pending}>
          <p className="auth-subtitle">{mode === 'reset_password' ? 'Enter your email to request a reset link.' : mode === 'sign_up' ? 'Set up your workspace to start resolving records.' : 'Sign in to continue reviewing cases.'}</p>
          {mode === 'reset_password' && resetSent ? <>
            <div className="auth-reset-status"><InlineFeedback>If an account exists for that email, a password reset link has been sent.</InlineFeedback></div>
            <Button variant="quiet" onClick={() => switchView('sign_in')} className="auth-back">Back to sign in</Button>
          </> : <>
            <div className="auth-fields">
              {emailField}
              {mode !== 'reset_password' && <Field id="auth-password" label="Password" hint={mode === 'sign_up' ? 'Use at least 6 characters.' : undefined} action={mode === 'sign_in' ? <Button variant="quiet" disabled={pending} onClick={() => switchView('reset_password')} className="auth-link">Forgot password?</Button> : undefined}>
                {(accessibility) => <div className="auth-password-input">
                  <TextInput {...accessibility} required disabled={pending} minLength={6} autoComplete={mode === 'sign_in' ? 'current-password' : 'new-password'} type={showPassword ? 'text' : 'password'} placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={passwordInvalid || undefined} aria-describedby={[accessibility['aria-describedby'], visibleError ? 'auth-error' : undefined].filter(Boolean).join(' ') || undefined} />
                  <Button variant="quiet" iconOnly disabled={pending} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)} className="auth-password-toggle">{showPassword ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}</Button>
                </div>}
              </Field>}
            </div>
            {errorFeedback}
            <Button type="submit" variant="primary" disabled={pending} loading={operation === 'sign_in' || operation === 'sign_up' || operation === 'password_reset'} className="auth-submit">{operation === 'password_reset' ? 'Sending reset link…' : operation === 'sign_up' ? 'Creating account…' : operation === 'sign_in' ? 'Signing in…' : mode === 'reset_password' ? 'Send reset link' : mode === 'sign_up' ? 'Create account' : 'Sign in'}</Button>
            {mode === 'reset_password' ? <Button variant="quiet" disabled={pending} onClick={() => switchView('sign_in')} className="auth-back">Back to sign in</Button> : <>
              <p className="auth-switch">{mode === 'sign_in' ? 'New to the workbench?' : 'Already have an account?'}{' '}<Button variant="quiet" disabled={pending} onClick={() => switchView(mode === 'sign_in' ? 'sign_up' : 'sign_in')} className="auth-link">{mode === 'sign_in' ? 'Create account' : 'Back to sign in'}</Button></p>
              <div className="auth-divider"><span>or</span></div>
              <Button onClick={() => void continueAsDemo()} disabled={pending} loading={operation === 'demo'} className="auth-demo">{operation === 'demo' ? 'Opening demo workspace…' : 'Explore demo workspace'}</Button>
              <p className="auth-demo-copy">No account required</p>
            </>}
          </>}
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{progress}</p>
        </form>}
      </section>
    </div>
  </main>;
}
