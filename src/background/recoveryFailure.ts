import { decodeError } from '../shared/errors';
import type { ProviderFailureKind } from '../shared/types';

const insertionKeys = new Set([
  'error.input_not_found',
  'error.input_injection_failed',
  'error.input_disappeared',
  'error.existing_draft',
]);

const submissionKeys = new Set([
  'error.send_failed',
  'error.send_action_unavailable',
  'error.send_action_disabled',
  'error.send_unconfirmed',
  'error.send_rejected',
  'error.response_in_progress',
]);

/**
 * Maps only structured extension errors and short provider error labels to a
 * diagnostic category. The original reason remains intact for the recovery
 * panel; this value intentionally contains no prompt or response content.
 */
export function classifyProviderFailure(reason: string): ProviderFailureKind {
  const key = decodeError(reason)?.key;
  if (key && insertionKeys.has(key)) return 'prompt_insertion';
  if (key && submissionKeys.has(key)) return 'submission';
  if (key === 'error.timeout') return 'response_timeout';
  if (key === 'error.no_response_text') return 'response_extraction';
  if (key === 'error.reloaded' || key === 'error.navigated_away' || key === 'error.tab_closed') return 'navigation';
  if (key === 'error.not_ready') return 'authentication';

  const normalized = reason.replace(/^\[?Error:\s*/i, '').replace(/]$/, '').trim();
  if (/\b(quota|rate\s*limit|usage\s*limit|too many requests|capacity)\b/i.test(normalized)) return 'quota_or_rate_limit';
  if (/\b(sign\s*in|log\s*in|auth(?:entication)?|unauthori[sz]ed|session expired)\b/i.test(normalized)) return 'authentication';
  if (/\b(navigat(?:ed|ion)|reload(?:ed)?|tab closed|page (?:was )?closed)\b/i.test(normalized)) return 'navigation';
  return 'unexpected';
}
