import { describe, expect, it, vi } from 'vitest';
import { dispatch } from '../workers/press-box-dispatch/src/index';

describe('hourly dispatch', () => {
  it('dispatches the main workflow', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await dispatch({ GITHUB_ACTIONS_TOKEN: 'test-token' }, fetcher as typeof fetch);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/actions/workflows/press-box.yml/dispatches');
    expect(JSON.parse(String(init.body))).toEqual({ ref: 'main', inputs: { mode: 'daily' } });
  });
  it('reports status without exposing the token', async () => {
    const fetcher = vi.fn(async () => new Response('secret', { status: 403 }));
    await expect(dispatch({ GITHUB_ACTIONS_TOKEN: 'test-token' }, fetcher as typeof fetch)).rejects.toThrow('HTTP 403');
  });
});
