import { authConfig } from "breeze-plugin-kit";
import { USER_AGENT, absoluteUrl, cleanText } from "./common";
import {
  deriveImageHost,
  getOrigin,
  isSiteHost,
  looksLikeParkedPage,
  originHost,
} from "./origin";
import { discoverOrigin, loadPersistedOrigin } from "./site";

const COOKIE_CONFIG_KEY = "auth.cookie";

let cookieCache = "";
let cookieLoaded = false;

/** 域名只从持久化配置恢复一次 */
let originLoaded = false;

async function ensureOriginLoaded(): Promise<void> {
  if (originLoaded) {
    return;
  }
  originLoaded = true;
  try {
    await loadPersistedOrigin();
  } catch {
    // 恢复失败沿用默认域名
  }
}

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
  const headerMatch = value.match(/cookie\s*:\s*([\s\S]+)/i);
  if (headerMatch) {
    value = headerMatch[1];
  }
  return value
    .split(/[\r\n]+/)
    .join("; ")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .join("; ");
}

/** 判断 Cookie 中是否包含登录会话键 */
export function hasLoginSession(cookie: string): boolean {
  if (!cookie) {
    return false;
  }
  return /(?:^|;\s*)(?:[a-z0-9_]*auth|[a-z0-9_]*sid|[a-z0-9_]*login)/i.test(cookie);
}

function refererFor(): string {
  return `${getOrigin()}/pc/pc/`;
}

/** 构造通用请求头 */
export function buildHeaders(url: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
    Referer: refererFor(),
    ...extra,
  };
  if (cookieCache) {
    headers.Cookie = cookieCache;
  }
  return headers;
}

export type FetchTextResult = {
  ok: boolean;
  status: number;
  url: string;
  text: string;
};

/** 通用文本请求（用于外部站点，不参与域名自动切换） */
export async function fetchText(
  url: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<FetchTextResult> {
  await ensureCookie();
  const target = absoluteUrl(url);
  const res = await fetch(target, {
    headers: buildHeaders(target, options.headers),
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, url: res.url || target, text };
}

/** 单次站内请求；失败返回 null 而不抛错，交给上层决定是否换域名 */
async function trySiteFetch(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: buildHeaders(url),
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.log("[zerobyw] 请求失败:", res.status, url);
      return null;
    }
    const text = await res.text();
    if (!cleanText(text)) {
      console.log("[zerobyw] 响应为空:", url);
      return null;
    }
    if (looksLikeParkedPage(text)) {
      console.log("[zerobyw] 命中域名停放页:", url);
      return null;
    }
    return text;
  } catch (error) {
    console.log("[zerobyw] 请求异常:", url, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * 请求站内页面（传相对路径，如 `/pc/pc/?page=1`）。
 *
 * 域名失效时（DNS 失败 / 连接被重置 / 404 / 停放页）会自动去官方发布页
 * 发现最新域名，并用新域名重试一次。
 */
export async function fetchSitePath(
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  await ensureCookie();
  await ensureOriginLoaded();

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const timeoutMs = options.timeoutMs ?? 20000;

  const firstOrigin = getOrigin();
  const first = await trySiteFetch(`${firstOrigin}${normalizedPath}`, timeoutMs);
  if (first !== null) {
    return first;
  }

  console.log("[zerobyw] 当前域名请求失败，触发域名发现:", firstOrigin);
  let nextOrigin = firstOrigin;
  try {
    nextOrigin = await discoverOrigin();
  } catch (error) {
    console.log("[zerobyw] 域名发现失败:", error instanceof Error ? error.message : error);
  }

  if (nextOrigin && nextOrigin !== firstOrigin) {
    const second = await trySiteFetch(`${nextOrigin}${normalizedPath}`, timeoutMs);
    if (second !== null) {
      return second;
    }
    console.log("[zerobyw] 新域名重试仍失败:", nextOrigin);
  }

  const tried = nextOrigin !== firstOrigin ? `${firstOrigin} 与 ${nextOrigin}` : firstOrigin;
  throw new Error(`请求失败，且未找到可用域名（已尝试 ${tried}）`);
}

/** 请求站内 JSON 接口（保留给站点改版使用） */
export async function fetchSiteJson<T = unknown>(path: string): Promise<T> {
  const text = await fetchSitePath(path);
  return JSON.parse(text) as T;
}

async function tryImage(target: string, timeoutMs: number): Promise<Uint8Array | null> {
  try {
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
      console.log("[zerobyw] 图片请求失败:", res.status, target);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    console.log("[zerobyw] 图片请求异常:", target, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * 下载图片。
 * 图片走 tupa 独立 CDN；主站换域名后 CDN 域名会跟着变，
 * 所以原地址失败时按当前主站域名推导新 CDN 域名重试。
 */
export async function fetchImage(url: string, timeoutMs = 30000): Promise<Uint8Array> {
  await ensureCookie();
  await ensureOriginLoaded();

  const target = absoluteUrl(url);
  const direct = await tryImage(target, timeoutMs);
  if (direct) {
    return direct;
  }

  let host = "";
  try {
    host = new URL(target).hostname;
  } catch {
    host = "";
  }

  if (host && isSiteHost(host)) {
    const derived = deriveImageHost(originHost());
    if (derived && derived !== host) {
      const retried = await tryImage(target.replace(host, derived), timeoutMs);
      if (retried) {
        console.log("[zerobyw] 图片改用当前 CDN 域名成功:", derived);
        return retried;
      }
    }

    try {
      await discoverOrigin();
    } catch {
      // 忽略，走最终报错
    }
    const derivedAfter = deriveImageHost(originHost());
    if (derivedAfter && derivedAfter !== host) {
      const retried = await tryImage(target.replace(host, derivedAfter), timeoutMs);
      if (retried) {
        console.log("[zerobyw] 图片改用新发现域名成功:", derivedAfter);
        return retried;
      }
    }
  }

  throw new Error("图片下载失败，且未找到可用图片域名");
}
