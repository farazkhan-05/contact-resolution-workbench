import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthScreen } from './AuthScreen';
import { useAuth } from './AuthProvider';

vi.mock('./AuthProvider', () => ({ useAuth: vi.fn() }));
let session: ReturnType<typeof useAuth>;
beforeEach(() => {
  session = { status: 'signed_out', workspace: null, error: null, authenticated: false, accountCreated: false, operation: null,
    signIn: vi.fn(async () => {}), signUp: vi.fn(async () => {}), resetPassword: vi.fn(async () => null),
    continueAsDemo: vi.fn(async () => {}), retryBootstrap: vi.fn(async () => {}), signOutUser: vi.fn(async () => {}),
  };
  vi.mocked(useAuth).mockImplementation(() => session);
});
afterEach(cleanup);

describe('authentication presentation', () => {
  it('moves focus to the new heading when changing views and keeps signup requirements', () => {
    render(<AuthScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Create your account' }));
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password.minLength).toBe(6);
    expect(password.autocomplete).toBe('new-password');
    expect(document.getElementById(password.getAttribute('aria-describedby')!)?.textContent).toBe('Use at least 6 characters.');
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Reset your password' }));
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it.each([
    ['The email or password is incorrect.', true, true],
    ['Enter a valid email address.', true, false],
    ['Choose a password with at least 6 characters.', false, true],
    ['Could not connect. Check your connection and try again.', false, false],
  ])('associates mapped error %s without inventing field validation', (error, emailInvalid, passwordInvalid) => {
    session.error = error;
    render(<AuthScreen />);
    expect(screen.getByRole('alert').textContent).toBe(error);
    for (const [label, invalid] of [['Email', emailInvalid], ['Password', passwordInvalid]] as const) {
      const input = screen.getByLabelText(label);
      expect(input.getAttribute('aria-describedby')).toBe('auth-error');
      expect(input.getAttribute('aria-invalid')).toBe(invalid ? 'true' : null);
    }
  });

  it.each([
    ['sign_in', 'Signing in…'], ['sign_up', 'Creating account…'], ['demo', 'Opening demo workspace…'],
  ] as const)('announces %s and disables all form actions', (operation, label) => {
    session.operation = operation;
    render(<AuthScreen />);
    expect(screen.getByRole('status').textContent).toBe(label);
    expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(true);
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Email') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('form').getAttribute('aria-busy')).toBe('true');
  });

  it.each([
    ['loading', null, 'Restoring your session…', 'Checking your existing session'],
    ['bootstrapping', null, 'Starting your workspace…', 'You are signed in.'],
    ['ready', 'sign_out', 'Signing out…', 'Closing your session.'],
  ] as const)('distinguishes %s / %s and offers no auth form or bootstrap action', (status, operation, heading, announcement) => {
    session.status = status; session.operation = operation;
    render(<AuthScreen />);
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(announcement);
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(session.retryBootstrap).not.toHaveBeenCalled();
  });

  it('explains account creation separately from initialization and keeps explicit recovery', () => {
    session.authenticated = true; session.accountCreated = true; session.status = 'bootstrapping';
    const view = render(<AuthScreen />);
    expect(screen.getByRole('status').textContent).toContain('Your account is created. Preparing your workspace');
    session.status = 'error'; session.error = 'The workspace service is temporarily unavailable. Please retry.';
    view.rerender(<AuthScreen />);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Workspace setup' }));
    expect(screen.queryByLabelText('Password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(session.retryBootstrap).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(session.signOutUser).toHaveBeenCalledTimes(1);
  });
});
