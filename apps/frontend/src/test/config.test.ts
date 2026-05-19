import { describe, it, expect } from 'vitest';
import { API_BASE_URL, SOCKET_URL } from '../config';

describe('Frontend Configuration', () => {
  it('should have a defined API_BASE_URL', () => {
    expect(API_BASE_URL).toBeDefined();
    expect(typeof API_BASE_URL).toBe('string');
  });

  it('should have a defined SOCKET_URL', () => {
    expect(SOCKET_URL).toBeDefined();
    expect(typeof SOCKET_URL).toBe('string');
  });

  it('should point to localhost by default in test/dev', () => {
    // This depends on the environment, but in vitest it usually defaults to the fallback
    expect(API_BASE_URL).toContain('localhost');
  });
});
