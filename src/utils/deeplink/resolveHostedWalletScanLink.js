/**
 * Resolve marketplace-hosted short scan links for oversized GenericRequest deeplinks.
 *
 * QR encodes: https://<CALLBACK_HOST>/api/wallet/r/<64-hex>
 * Response JSON: { deepLink: "verus://1/..." } — full request including attestation.
 *
 * Only fetches https URLs whose path matches the wallet scan-link pattern so we
 * never hit arbitrary hosts from a scanned QR.
 */

const SCAN_PATH_RE = /^\/api\/wallet\/r\/([a-f0-9]{64})$/i;

/**
 * @param {string} urlstring
 * @returns {Promise<string|null>} full verus:// deeplink, or null if not a scan link
 */
export async function resolveHostedWalletScanLink(urlstring) {
  let url;
  try {
    url = new URL(urlstring);
  } catch (e) {
    return null;
  }

  if (url.protocol !== 'https:') {
    return null;
  }

  const match = url.pathname.match(SCAN_PATH_RE);
  if (!match) {
    return null;
  }

  const res = await fetch(urlstring, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Verus-Mobile': '1',
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`Failed to load wallet request (${res.status})`);
  }

  const data = await res.json();
  const deepLink = typeof data?.deepLink === 'string' ? data.deepLink : null;
  if (!deepLink || !deepLink.startsWith('verus://')) {
    throw new Error('Invalid wallet request payload');
  }

  return deepLink;
}

export function isHostedWalletScanLink(urlstring) {
  try {
    const url = new URL(urlstring);
    return url.protocol === 'https:' && SCAN_PATH_RE.test(url.pathname);
  } catch (e) {
    return false;
  }
}
