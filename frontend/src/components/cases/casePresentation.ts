import type { ReviewDecision, RoutingStatus } from '../../types';

export const recommendationLabel: Record<RoutingStatus, string> = {
  LIKELY_MATCH: 'Likely match', NEEDS_REVIEW: 'Needs review', NO_RELIABLE_MATCH: 'No reliable match',
};
export const decisionLabel: Record<ReviewDecision, string> = {
  PENDING: 'Not reviewed', ACCEPTED: 'Accepted', REJECTED: 'Rejected', NEED_MORE_EVIDENCE: 'More evidence needed',
};
export const recommendationTone = (status: RoutingStatus) => status === 'LIKELY_MATCH' ? 'success' : status === 'NEEDS_REVIEW' ? 'warning' : 'neutral';
