/** Hourly backup trigger for the Press Box GitHub Actions workflow. */
interface Env { GITHUB_ACTIONS_TOKEN: string }

export async function dispatch(env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  if (!env.GITHUB_ACTIONS_TOKEN) throw new Error('Missing GITHUB_ACTIONS_TOKEN');
  const response = await fetcher('https://api.github.com/repos/ryan-blacksite/press-box/actions/workflows/press-box.yml/dispatches', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'press-box-hourly-dispatch',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'main', inputs: { mode: 'daily' } }),
  });
  if (!response.ok) throw new Error(`GitHub workflow dispatch failed: HTTP ${response.status}`);
}

export default {
  scheduled(_event: unknown, env: Env, context: { waitUntil(promise: Promise<void>): void }): void {
    context.waitUntil(dispatch(env));
  },
};
