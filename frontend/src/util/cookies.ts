// Small helpers for reading/writing document cookies used to persist UI state
// (e.g. the last selected object and the last render/texture tier) across reloads.

export function setCookie(name: string, value: string, days = 365): void {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

export function getCookie(name: string): string | null {
  const prefix = name + '=';
  const row = document.cookie.split('; ').find(r => r.startsWith(prefix));
  return row ? decodeURIComponent(row.slice(prefix.length)) : null;
}

export function deleteCookie(name: string): void {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
}
