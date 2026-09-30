import type { CaseDetail, CaseSummary, CsvIngestResponse, DecisionPayload, ReviewDecision, RoutingStatus, SampleIngestResponse, UnstructuredIngestRequest, UnstructuredIngestResponse } from '../types';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
export interface WorkspaceSummary { id: string; name: string; role: string; }
export interface AuthBootstrapResponse { user: { id: string; is_anonymous: boolean }; workspaces: WorkspaceSummary[]; }
type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider | null = null;
let activeWorkspaceId: string | null = null;

export function setAuthenticatedApiSession(provider: TokenProvider, workspaceId: string): void { tokenProvider = provider; activeWorkspaceId = workspaceId; }
export function clearAuthenticatedApiSession(): void { tokenProvider = null; activeWorkspaceId = null; }

export class ApiError extends Error {
  constructor(public status: number, public detail: string) { super(detail); this.name = 'ApiError'; }
}

async function authHeaders(requireWorkspace: boolean, contentType = false): Promise<Headers> {
  const token = await tokenProvider?.();
  if (!token) throw new ApiError(401, 'Please sign in to continue.');
  if (requireWorkspace && !activeWorkspaceId) throw new ApiError(403, 'No workspace is active.');
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (requireWorkspace && activeWorkspaceId) headers.set('X-Workspace-ID', activeWorkspaceId);
  if (contentType) headers.set('Content-Type', 'application/json');
  return headers;
}

async function request(path: string, init: RequestInit, requireWorkspace = true): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { ...init, headers: await authHeaders(requireWorkspace, typeof init.body === 'string') });
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorDetail = 'Request failed';
    try { const data = await response.json(); errorDetail = typeof data.detail === 'string' ? data.detail : data.message || errorDetail; }
    catch { errorDetail = response.statusText || `HTTP ${response.status}`; }
    throw new ApiError(response.status, errorDetail);
  }
  return response.json() as Promise<T>;
}

export const api = {
  async bootstrap(): Promise<AuthBootstrapResponse> { return handleResponse(await request('/api/v1/auth/bootstrap', { method: 'POST' }, false)); },
  async ingestSample(): Promise<SampleIngestResponse> { return handleResponse(await request('/api/v1/ingest/sample', { method: 'POST' })); },
  async ingestCsv(file: File): Promise<CsvIngestResponse> { const body = new FormData(); body.append('file', file); return handleResponse(await request('/api/v1/ingest/csv', { method: 'POST', body })); },
  async getCases(params?: { routing_status?: RoutingStatus; review_decision?: ReviewDecision; search?: string }): Promise<CaseSummary[]> {
    const query = new URLSearchParams();
    if (params?.routing_status) query.set('routing_status', params.routing_status);
    if (params?.review_decision) query.set('review_decision', params.review_decision);
    if (params?.search) query.set('search', params.search);
    return handleResponse(await request(`/api/v1/cases${query.toString() ? `?${query}` : ''}`, { method: 'GET' }));
  },
  async getCase(caseId: string): Promise<CaseDetail> { return handleResponse(await request(`/api/v1/cases/${caseId}`, { method: 'GET' })); },
  async submitDecision(caseId: string, payload: DecisionPayload): Promise<CaseDetail> { return handleResponse(await request(`/api/v1/cases/${caseId}/decision`, { method: 'POST', body: JSON.stringify(payload) })); },
  async exportReviewedCsv(): Promise<Blob> { const res = await request('/api/v1/export/csv', { method: 'GET' }); if (!res.ok) throw new ApiError(res.status, 'Failed to download export CSV'); return res.blob(); },
  async ingestUnstructured(payload: UnstructuredIngestRequest): Promise<UnstructuredIngestResponse> { return handleResponse(await request('/api/v1/ingest/unstructured', { method: 'POST', body: JSON.stringify(payload) })); },
};
