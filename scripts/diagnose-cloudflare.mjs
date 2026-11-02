import { appendFileSync } from 'node:fs';

const clean = (value) => (value ?? '').replace(/\s+/g, '');
const token = clean(process.env.CLOUDFLARE_API_TOKEN);
const account = clean(process.env.CLOUDFLARE_ACCOUNT_ID);
const namespace = clean(process.env.PRESS_BOX_KV_NAMESPACE_ID) || 'd9995262f8404a659e3ea0b880d8493a';
const base = 'https://api.cloudflare.com/client/v4';

async function check(path) {
  try {
    const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, success: body.success === true, result: body.result, codes: Array.isArray(body.errors) ? body.errors.map(e => e.code).filter(Number.isInteger) : [] };
  } catch {
    return { status: 0, success: false, codes: [] };
  }
}

if (!token || !account) {
  console.log('Cloudflare diagnostic: account ID or token is empty.');
  process.exitCode = 1;
} else {
  const [user, accountToken, kv, accounts] = await Promise.all([
    check('/user/tokens/verify'),
    check(`/accounts/${encodeURIComponent(account)}/tokens/verify`),
    check(`/accounts/${encodeURIComponent(account)}/storage/kv/namespaces/${encodeURIComponent(namespace)}`),
    check('/accounts?per_page=50'),
  ]);
  const active = (r) => r.success && r.result?.status === 'active';
  const show = (name, r) => `${name}: HTTP ${r.status || 'network error'}${r.codes.length ? ` (error codes ${r.codes.join(', ')})` : ''}`;
  const lines = [show('User token verification', user), show('Account token verification', accountToken), show('KV namespace', kv), show('Account listing', accounts)];
  const listed = accounts.success && Array.isArray(accounts.result) ? accounts.result.some(item => item.id === account) : null;
  if (kv.success) lines.push('Result: token can access the configured KV namespace.');
  else if (active(user) || active(accountToken)) {
    if (listed === false) lines.push('Result: the configured account is not among accounts visible to this token; account ID or token account scope needs correction.');
    else lines.push('Result: token is active, but namespace access failed. Check KV permissions, account scope and namespace ID; these responses cannot distinguish them.');
  } else if (user.status === 401 && accountToken.status === 401) {
    lines.push('Result: neither token verification endpoint authenticated this credential for the configured account. The token may be invalid, or it may be an account token for another account; these responses cannot distinguish them.');
  } else lines.push('Result: inconclusive. Check token type, account ID, and the HTTP statuses above.');
  const report = lines.join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Cloudflare diagnostic\n\n${lines.map(line => `- ${line}`).join('\n')}\n`);
  if (!kv.success) process.exitCode = 1;
}
