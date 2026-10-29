/** Only local navigation can cross the browser/app boundary. */
export function continuationPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === '/') return value;
  if (/^\/invite\/[A-Za-z0-9]{1,32}\/?$/.test(value)) return value.replace(/\/$/, '');
  if (/^\/servers\/[0-9a-fA-F-]{1,64}$/.test(value)) return value;
  if (/^\/channels\/[0-9a-fA-F-]{1,64}\/[0-9a-fA-F-]{1,64}$/.test(value)) return value;
  return null;
}

export type BirthdayVisibility = 'full' | 'month_day' | 'hidden';
export interface BrowserSignInOptions {
  invite?: string; register?: boolean; username?: string; displayName?: string; path?: string;
  email?: string; birthday?: string; birthdayVisibility?: BirthdayVisibility;
}

function isBirthDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
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
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (email && email.length <= 254 && email.includes('@') && !/[\s\u0000-\u001f\u007f]/.test(email)) result.email = email;
  if (typeof input.birthday === 'string' && isBirthDate(input.birthday)) result.birthday = input.birthday;
  if (input.birthdayVisibility === 'full' || input.birthdayVisibility === 'month_day' || input.birthdayVisibility === 'hidden') {
    result.birthdayVisibility = input.birthdayVisibility;
  }
  result.path = continuationPath(input.path) ?? (result.invite ? `/invite/${result.invite}` : '/');
  return result;
}

/** Email and birth date for the browser's Register form. They go in the URL
 *  fragment, which never reaches a server or proxy log; the page reads it with
 *  URLSearchParams and clears it. Empty when there's nothing to carry. */
export function signupFragment(options: BrowserSignInOptions): string {
  const params = new URLSearchParams();
  if (options.email) params.set('email', options.email);
  if (options.birthday) params.set('birthday', options.birthday);
  if (options.birthdayVisibility) params.set('birthday_visibility', options.birthdayVisibility);
  return params.toString();
}
