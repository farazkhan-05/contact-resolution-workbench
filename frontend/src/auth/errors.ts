import { ApiError } from '../api/client';

export function firebaseErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  switch (code) {
    case 'auth/email-already-in-use': return 'An account already exists with this email. Sign in to continue.';
    case 'auth/invalid-email': return 'Enter a valid email address.';
    case 'auth/weak-password': return 'Choose a password with at least 6 characters.';
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/user-not-found':
    case 'auth/wrong-password': return 'The email or password is incorrect.';
    case 'auth/network-request-failed': return 'Could not connect. Check your connection and try again.';
    case 'auth/too-many-requests': return 'Too many attempts. Please wait and try again.';
    default: return 'Authentication could not be completed. Please try again.';
  }
}

export function bootstrapErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return 'The workspace service could not verify your session. Retry, or sign out and sign in again.';
    if (error.status >= 500) return 'The workspace service is temporarily unavailable. Please retry.';
  }
  if (error instanceof TypeError) return 'Could not reach the workspace service. Check your connection and retry.';
  return 'The workspace could not be initialized. Please retry.';
}
