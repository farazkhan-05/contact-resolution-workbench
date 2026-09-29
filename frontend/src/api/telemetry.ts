const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

const SESSION_STORAGE_SESSION_ID_KEY = 'crw_anonymous_session_id';
const SESSION_STORAGE_REF_CODE_KEY = 'crw_ref_code';
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export type TelemetryEventType =
  | 'APP_OPENED'
  | 'SAMPLE_CASES_LOADED'
  | 'CASE_VIEWED'
  | 'DECISION_SUBMITTED'
  | 'CSV_UPLOADED'
  | 'CSV_EXPORTED';

function getOrCreateAnonymousSessionId(): string {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) {
      return 'anonymous_session';
    }
    let sessionId = window.sessionStorage.getItem(SESSION_STORAGE_SESSION_ID_KEY);
    if (!sessionId || !SAFE_IDENTIFIER_REGEX.test(sessionId)) {
      sessionId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `sess_${Math.random().toString(36).substring(2, 15)}`;
      window.sessionStorage.setItem(SESSION_STORAGE_SESSION_ID_KEY, sessionId);
    }
    return sessionId;
  } catch {
    return 'anonymous_session';
  }
}

function getSanitizedRefCode(): string | null {
  try {
    if (typeof window === 'undefined') {
      return null;
    }

    // Check cached ref code in sessionStorage first
    if (window.sessionStorage) {
      const cached = window.sessionStorage.getItem(SESSION_STORAGE_REF_CODE_KEY);
      if (cached && SAFE_IDENTIFIER_REGEX.test(cached)) {
        return cached;
      }
    }

    // Parse and sanitize query parameter ?ref=...
    if (window.location && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      const rawRef = params.get('ref');
      if (rawRef) {
        const trimmed = rawRef.trim();
        if (SAFE_IDENTIFIER_REGEX.test(trimmed)) {
          if (window.sessionStorage) {
            window.sessionStorage.setItem(SESSION_STORAGE_REF_CODE_KEY, trimmed);
          }
          return trimmed;
        }
      }
    }
  } catch {
    // Swallow any storage or URL parsing issues safely
  }
  return null;
}

export function recordUsageEvent(
  eventName: TelemetryEventType,
  caseNumber?: string | null
): void {
  try {
    const anonymousSessionId = getOrCreateAnonymousSessionId();
    const refCode = getSanitizedRefCode();

    const sanitizedCaseNumber =
      caseNumber && SAFE_IDENTIFIER_REGEX.test(caseNumber.trim())
        ? caseNumber.trim()
        : null;

    const payload: {
      event_name: TelemetryEventType;
      anonymous_session_id: string;
      ref_code?: string;
      case_number?: string;
    } = {
      event_name: eventName,
      anonymous_session_id: anonymousSessionId,
    };

    if (refCode) {
      payload.ref_code = refCode;
    }
    if (sanitizedCaseNumber) {
      payload.case_number = sanitizedCaseNumber;
    }

    fetch(`${BASE_URL}/api/v1/usage-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Fire-and-forget: swallow network failures so UI workflow never breaks
    });
  } catch {
    // Fire-and-forget: swallow all exceptions
  }
}
