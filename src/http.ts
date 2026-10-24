import { authConfig } from "breeze-plugin-kit";
import { PLUGIN_ID, SITE_ORIGIN, USER_AGENT, absoluteUrl, cleanText } from "./common";

const COOKIE_CONFIG_KEY = "auth.cookie";

let cookieCache = "";
let cookieLoaded = false;

/** 读取并缓存用户 Cookie（登录态由插件自行维护，宿主不参与） */
export async function ensureCookie(): Promise<string> {
  if (cookieLoaded) {
    return cookieCache;
  }
  try {
    const raw = await authConfig.load(COOKIE_CONFIG_KEY, "");
    cookieCache = normalizeCookie(raw);
  } catch {
    cookieCache = "";
  }
  cookieLoaded = true;
  return cookieCache;
}

/** 保存 Cookie 到持久化配置 */
export async function saveCookie(raw: unknown): Promise<string> {
  const normalized = normalizeCookie(raw);
  cookieCache = normalized;
  cookieLoaded = true;
  try {
    await authConfig.save(COOKIE_CONFIG_KEY, normalized);
  } catch {
    // 持久化失败不影响本次会话
  }
  return normalized;
}

/** 清除 Cookie */
export async function clearCookie(): Promise<void> {
  await saveCookie("");
}

/** 把用户粘贴的多种格式整理成请求头可直接用的 Cookie 字符串 */
export function normalizeCookie(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  let value = raw.trim();
  if (!value) {
    return "";
  }
  // 支持整段请求头粘贴：Cookie: a=1; b=2
  const headerMatch = value.match(/cookie\s*:\s*([\s\S]+)/i);
  if (headerMatch) {
    value = headerMatch[1];
  }
  // 去掉换行与多余空白，规范为 `k=v; k=v`
  return value
    .split(/[\r\n]+/)
    .join("; ")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .join("; ");
}

/** 判断 Cookie 中是否包含站点需要的登录会话键 */
export function hasLoginSession(cookie: string): boolean {
  if (!cookie) {
    return false;
  }
  return /(?:^|;\s*)(?:[a-z0-9_]*auth|[a-z0-9_]*sid|[a-z0-9_]*login)/i.test(cookie);
}

function refererFor(url: string): string {
  if (url.includes("/pc/view/")) {
    return `${SITE_ORIGIN}/pc/pc/`;
  }
  if (url.includes("/pc/details/")) {
    return `${SITE_ORIGIN}/pc/pc/`;
  }
  return `${SITE_ORIGIN}/`;
}

/** 构造通用请求头 */
export function buildHeaders(url: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
    Referer: refererFor(url),
    ...extra,
  };
  const cookie = cookieCache;
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

export type FetchTextResult = {
  ok: boolean;
  status: number;
  url: string;
  text: string;
};

/** 请求 HTML / 文本 */
export async function fetchText(
  pathOrUrl: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<FetchTextResult> {
  await ensureCookie();
  const url = absoluteUrl(pathOrUrl);
  const timeoutMs = options.timeoutMs ?? 20000;
  const res = await fetch(url, {
    headers: buildHeaders(url, options.headers),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    url: res.url || url,
    text,
  };
}

/** 请求 JSON（站点若改版走接口时使用） */
export async function fetchJson<T = unknown>(
  pathOrUrl: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const text = (await fetchText(pathOrUrl, {
    ...options,
    headers: { Accept: "application/json, text/plain, */*", ...(options.headers ?? {}) },
  })).text;
  return JSON.parse(text) as T;
}

/** 请求页面并要求成功，失败时抛出可读错误 */
export async function fetchPage(
  pathOrUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const result = await fetchText(pathOrUrl, options);
  if (!result.ok) {
    throw new Error(`请求失败（HTTP ${result.status}）：${absoluteUrl(pathOrUrl)}`);
  }
  if (!cleanText(result.text)) {
    throw new Error(`页面内容为空：${absoluteUrl(pathOrUrl)}`);
  }
  return result.text;
}

/** 下载图片二进制 */
export async function fetchImage(url: string, timeoutMs = 30000): Promise<Uint8Array> {
  await ensureCookie();
  const target = absoluteUrl(url);
  const res = await fetch(target, {
    headers: buildHeaders(target, {
      // 必须带该头，让宿主透传原始二进制
      "x-rquickjs-host-offload-binary-v1": "1",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`图片下载失败（HTTP ${res.status}）`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
