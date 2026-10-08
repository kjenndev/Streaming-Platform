import axios, { CanceledError, type InternalAxiosRequestConfig } from 'axios';
import { API_BASE_URL } from './config';

const event = 'account-session-change';
let expired = false;
export const sessionExpired = () => expired;
export const sessionToken = () => localStorage.getItem('token');
export const subscribeSession = (notify: (change: Event) => void) => {
 window.addEventListener(event, notify);
 window.addEventListener('storage', notify);
 return () => { window.removeEventListener(event, notify); window.removeEventListener('storage', notify); };
};
export function clearIdentity(reason: 'expired' | 'logout' = 'logout') {
 expired = reason === 'expired';
 for (const key of ['token', 'username', 'roles', 'role']) localStorage.removeItem(key);
 window.dispatchEvent(new Event(event));
}
export function expireSession(token: string | null) {
 if (token && token === sessionToken()) clearIdentity('expired');
}
export function saveIdentity(data: {token: string; username: string; roles: string[]}) {
 expired = false;
 localStorage.removeItem('role');
 localStorage.setItem('username', data.username);
 localStorage.setItem('roles', JSON.stringify(data.roles || []));
 localStorage.setItem('token', data.token);
 window.dispatchEvent(new Event(event));
}
export function safeReturnTarget(value: unknown) {
 if (typeof value !== 'string') return '/dashboard';
 // Only local account routes; never login, protocol-relative or public capability URLs.
 return /^\/(dashboard(?:\/stream(?:\/[^/?#]+)?)?|users|settings)(?:[?#].*)?$/.test(value) ? value : '/dashboard';
}
function accountToken(config?: InternalAxiosRequestConfig) {
 if (!config?.url) return null;
 const url = new URL(config.url, window.location.origin);
 const base = new URL(API_BASE_URL, window.location.origin);
 if (url.origin !== base.origin || !/^\/api\/(streams|users|settings|metrics|logs|profile|recordings)(?:\/|$)/.test(url.pathname)) return null;
 const header = config.headers?.get?.('Authorization');
 return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}
// Account API responses only: public player/archive capability failures are separate.
axios.interceptors.response.use(response => {
 const token = accountToken(response.config);
 if (token && token !== sessionToken()) throw new CanceledError('Superseded session');
 return response;
}, error => {
 if (axios.isAxiosError(error)) {
  const token = accountToken(error.config);
  if (error.response?.status === 401 && !error.config?.signal?.aborted) expireSession(token);
 }
 return Promise.reject(error);
});
