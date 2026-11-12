import { afterEach, describe, expect, it, vi } from 'vitest';

const loadConfig = async () => {
  vi.resetModules();
  return import('../config');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Frontend Configuration', () => {
  it('preserves local backend defaults during development', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('VITE_MEDIA_URL', '');
    vi.stubEnv('VITE_SOCKET_URL', '');

    const { API_BASE_URL, MEDIA_BASE_URL, SOCKET_URL } = await loadConfig();

    expect(API_BASE_URL).toBe('http://localhost:3000');
    expect(MEDIA_BASE_URL).toBe('http://localhost:8000');
    expect(SOCKET_URL).toBe('http://localhost:3000');
  });

  it('defaults production endpoints to the current origin', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('VITE_MEDIA_URL', '');
    vi.stubEnv('VITE_SOCKET_URL', '');

    const { API_BASE_URL, MEDIA_BASE_URL, SOCKET_URL } = await loadConfig();

    expect(API_BASE_URL).toBe(window.location.origin);
    expect(MEDIA_BASE_URL).toBe(`${window.location.origin}/media`);
    expect(SOCKET_URL).toBe(window.location.origin);
  });

  it('preserves explicit Vite endpoint overrides', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    vi.stubEnv('VITE_MEDIA_URL', 'https://media.example.test');
    vi.stubEnv('VITE_SOCKET_URL', 'https://socket.example.test');

    const { API_BASE_URL, MEDIA_BASE_URL, SOCKET_URL } = await loadConfig();

    expect(API_BASE_URL).toBe('https://api.example.test');
    expect(MEDIA_BASE_URL).toBe('https://media.example.test');
    expect(SOCKET_URL).toBe('https://socket.example.test');
  });
});
