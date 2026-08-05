/**
 * Single POST of a marketplace callback after the wallet has already broadcast.
 *
 * Retries live on the API (rebroadcast hex + wait) and on user "Try Again"
 * via broadcastedRef in the deeplink screens — not here. A failed callback
 * must never be misread as "broadcast failed" (that causes re-sign / double-spend).
 */

function attachMoneySafety(err, body) {
  if (body && body.code) err.code = body.code;
  if (body && body.retryable === true) err.retryable = true;
  return err;
}

/**
 * @param {string} uri
 * @param {Record<string, unknown>} body
 * @returns {Promise<Record<string, unknown>>}
 */
export async function postMarketplaceCallback(uri, body) {
  let status = 0;
  let parsed = null;
  try {
    const res = await fetch(uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    status = res.status;
    parsed = await res.json().catch(() => ({}));
  } catch (networkErr) {
    const err = new Error(
      ((networkErr && networkErr.message) || 'Marketplace callback network error')
        + ' The transaction was already broadcast from this wallet — do not sign again.'
    );
    err.retryable = true;
    err.code = 'TX_PROPAGATING';
    throw err;
  }

  if (parsed && parsed.error) {
    throw attachMoneySafety(new Error(parsed.error), parsed);
  }

  if (status >= 400 && !(parsed && parsed.success)) {
    const err = new Error(
      `Marketplace callback HTTP ${status}. The transaction was already broadcast from this wallet — do not sign again.`
    );
    err.retryable = status === 503 || status === 429;
    err.code = status === 503 ? 'TX_PROPAGATING' : undefined;
    throw err;
  }

  return parsed || { success: true };
}
