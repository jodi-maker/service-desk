import { CUSTOMERS } from '../core/data.js';
import { apiPost, getJwt, getWorkspaceId } from '../core/api-client.js';
import { applyCustomerRow } from '../core/bootstrap.js';

// Per-object cache: switching workspace or reloading the customer collection
// cannot reuse another session's result. The API also throttles Maestro calls.
const attempts = new WeakMap();
const RETRY_MS = 60_000;

export async function refreshCustomerAccount(customer, onUpdated, onError) {
  if (!customer._uuid || customer.erased || customer.mergedInto || customer._mergedIntoUuid) return;
  if (customer.maestroUserId && ['username', 'brand', 'mobile', 'vip', 'jurisdiction'].every(k => String(customer[k] ?? '').trim())) return;
  const token = getJwt();
  const workspace = getWorkspaceId();
  if (!token || !workspace) return;
  const previous = attempts.get(customer);
  if (previous && (previous.pending || Date.now() - previous.at < RETRY_MS)) return;
  const attempt = { at: Date.now(), pending: true };
  attempts.set(customer, attempt);
  const before = JSON.stringify(customer);
  const stillCurrent = () => getJwt() === token && getWorkspaceId() === workspace && CUSTOMERS.includes(customer);
  try {
    const response = await apiPost(`/api/v1/customers/${customer._uuid}/refresh-account`, {});
    // A contact edit or another refresh may have completed while we waited.
    // Leave that newer local state alone; the next open can read server truth.
    if (!stillCurrent() || JSON.stringify(customer) !== before || !response?.customer) return;
    applyCustomerRow(customer, response.customer);
    onUpdated();
  } catch (err) {
    if (stillCurrent()) onError(err);
  } finally {
    attempt.pending = false;
    attempt.at = Date.now();
  }
}
