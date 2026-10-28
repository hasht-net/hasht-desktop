/** Only local navigation can cross the browser/app boundary. */
export function continuationPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === '/') return value;
  if (/^\/invite\/[A-Za-z0-9]{1,32}\/?$/.test(value)) return value.replace(/\/$/, '');
  if (/^\/servers\/[0-9a-fA-F-]{1,64}$/.test(value)) return value;
  if (/^\/channels\/[0-9a-fA-F-]{1,64}\/[0-9a-fA-F-]{1,64}$/.test(value)) return value;
  return null;
}

export interface BrowserSignInOptions { invite?: string; register?: boolean; username?: string; displayName?: string; path?: string }
export function browserSignInOptions(value: unknown): BrowserSignInOptions {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const result: BrowserSignInOptions = {};
  if (typeof input.invite === 'string' && /^[A-Za-z0-9]{1,32}$/.test(input.invite)) result.invite = input.invite;
  if (input.register === true) result.register = true;
  for (const key of ['username', 'displayName'] as const) {
    const name = typeof input[key] === 'string' ? input[key].trim() : '';
    if (name && name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(name)) result[key] = name;
  }
  result.path = continuationPath(input.path) ?? (result.invite ? `/invite/${result.invite}` : '/');
  return result;
}
