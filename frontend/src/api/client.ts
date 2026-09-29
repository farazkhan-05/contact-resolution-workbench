import type {
  CaseDetail,
  CaseSummary,
  CsvIngestResponse,
  DecisionPayload,
  ReviewDecision,
  RoutingStatus,
  SampleIngestResponse,
  UnstructuredIngestRequest,
  UnstructuredIngestResponse,
} from '../types';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorDetail = 'Request failed';
    try {
      const data = await response.json();
      if (typeof data.detail === 'string') {
        errorDetail = data.detail;
      } else if (Array.isArray(data.detail)) {
        errorDetail = data.detail.map((e: { msg?: string }) => e.msg || JSON.stringify(e)).join(', ');
      } else if (data.message) {
        errorDetail = data.message;
      }
    } catch {
      errorDetail = response.statusText || `HTTP ${response.status}`;
    }
    throw new ApiError(response.status, errorDetail);
  }
  return response.json() as Promise<T>;
}

export const api = {
  async ingestSample(): Promise<SampleIngestResponse> {
    const res = await fetch(`${BASE_URL}/api/v1/ingest/sample`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return handleResponse<SampleIngestResponse>(res);
  },

  async ingestCsv(file: File): Promise<CsvIngestResponse> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${BASE_URL}/api/v1/ingest/csv`, {
      method: 'POST',
      body: formData,
    });
    return handleResponse<CsvIngestResponse>(res);
  },

  async getCases(params?: {
    routing_status?: RoutingStatus;
    review_decision?: ReviewDecision;
    search?: string;
  }): Promise<CaseSummary[]> {
    const query = new URLSearchParams();
    if (params?.routing_status) query.set('routing_status', params.routing_status);
    if (params?.review_decision) query.set('review_decision', params.review_decision);
    if (params?.search) query.set('search', params.search);

    const queryString = query.toString() ? `?${query.toString()}` : '';
    const res = await fetch(`${BASE_URL}/api/v1/cases${queryString}`, {
      method: 'GET',
    });
    return handleResponse<CaseSummary[]>(res);
  },

  async getCase(caseId: string): Promise<CaseDetail> {
    const res = await fetch(`${BASE_URL}/api/v1/cases/${caseId}`, {
      method: 'GET',
    });
    return handleResponse<CaseDetail>(res);
  },

  async submitDecision(caseId: string, payload: DecisionPayload): Promise<CaseDetail> {
    const res = await fetch(`${BASE_URL}/api/v1/cases/${caseId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return handleResponse<CaseDetail>(res);
  },

  async exportReviewedCsv(): Promise<Blob> {
    const res = await fetch(`${BASE_URL}/api/v1/export/csv`, {
      method: 'GET',
    });
    if (!res.ok) {
      throw new ApiError(res.status, 'Failed to download export CSV');
    }
    return res.blob();
  },

  async ingestUnstructured(payload: UnstructuredIngestRequest): Promise<UnstructuredIngestResponse> {
    const res = await fetch(`${BASE_URL}/api/v1/ingest/unstructured`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return handleResponse<UnstructuredIngestResponse>(res);
  },
};
