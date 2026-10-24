/**
 * 域名自动发现
 *
 * 官方永久发布页 https://zerobyw.github.io/ 按时间倒序记录每次"更新域名"，
 * 每条公告带一个"点击进入"链接；页面顶部还有"zero搬运网镜像"按钮。
 *
 * 发现流程：
 *   抓发布页 → 收集候选（镜像按钮 > 点击进入 > 其它）→ 去重
 *   → 按顺序探测 /pc/pc/ 是否为真实站点页 → 第一个通过的即为新域名
 *   → 持久化到插件配置
 *
 * 本模块只使用原生 fetch，不 import http.ts，避免循环依赖。
 */
import { authConfig } from "breeze-plugin-kit";
import {
  DEFAULT_ORIGIN,
  getOrigin,
  isSiteHost,
  looksLikeParkedPage,
  looksLikeSitePage,
  normalizeOrigin,
  setOrigin,
} from "./origin";

/** 官方永久发布页 */
export const PUBLISHER_URL = "https://zerobyw.github.io/";

const ORIGIN_KEY = "site.origin";
const MAX_CANDIDATES = 8;
const PROBE_TIMEOUT_MS = 8000;

type Selection = {
  attr: (name: string) => string | undefined;
  text: () => string;
  each: (fn: (index: number, element: unknown) => void) => void;
};

type HtmlApi = ((selector: string) => Selection) & { load: (html: string) => HtmlApi };

function html(): HtmlApi {
  return (globalThis as unknown as { BreezeHtml: HtmlApi }).BreezeHtml;
}

const PROBE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

/** 从发布页 HTML 中按优先级收集候选域名 */
export function collectCandidates(publisherHtml: string): string[] {
  const $ = html().load(publisherHtml);
  const mirrors: string[] = [];
  const entries: string[] = [];
  const others: string[] = [];

  $("a").each((_, element) => {
    const $a = $(element as never);
    const href = String($a.attr("href") ?? "").trim();
    if (!href) {
      return;
    }
    let host = "";
    try {
      host = new URL(href.startsWith("//") ? `https:${href}` : href).hostname;
    } catch {
      return;
    }
    if (!isSiteHost(host)) {
      return;
    }
    const text = String($a.text() ?? "").trim();
    if (text.includes("镜像")) {
      mirrors.push(href);
    } else if (text.includes("点击进入")) {
      entries.push(href);
    } else {
      others.push(href);
    }
  });

  const ordered = [...mirrors, ...entries, ...others];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ordered) {
    const normalized = normalizeOrigin(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= MAX_CANDIDATES) {
      break;
    }
  }
  return result;
}

/** 探测某个域名是否真的是该站（https 优先，失败回落 http） */
async function probeOrigin(candidate: string): Promise<string | null> {
  const host = (() => {
    try {
      return new URL(candidate).hostname;
    } catch {
      return "";
    }
  })();
  if (!host) {
    return null;
  }

  for (const protocol of ["https", "http"]) {
    const base = `${protocol}://${host}`;
    try {
      const res = await fetch(`${base}/pc/pc/`, {
        headers: PROBE_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        continue;
      }
      const body = await res.text();
      if (looksLikeSitePage(body) && !looksLikeParkedPage(body)) {
        return base;
      }
    } catch {
      // 该协议不通，继续试下一个
    }
  }
  return null;
}

/** 从持久化配置恢复域名 */
export async function loadPersistedOrigin(): Promise<string> {
  try {
    const saved = await authConfig.load(ORIGIN_KEY, "");
    const normalized = normalizeOrigin(saved);
    if (normalized) {
      return setOrigin(normalized);
    }
  } catch {
    // 读取失败时沿用默认值
  }
  return getOrigin();
}

async function persistOrigin(origin: string): Promise<void> {
  try {
    await authConfig.save(ORIGIN_KEY, origin);
  } catch {
    // 持久化失败不影响本次会话
  }
}

let inflight: Promise<string> | null = null;

/**
 * 抓发布页并探测出可用域名。
 * 并发调用共享同一个发现过程，避免重复抓取。
 */
export async function discoverOrigin(): Promise<string> {
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    const current = getOrigin();
    console.log("[zerobyw] 开始从发布页发现域名:", PUBLISHER_URL);

    let publisherHtml = "";
    try {
      const res = await fetch(PUBLISHER_URL, {
        headers: PROBE_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        publisherHtml = await res.text();
      } else {
        console.log("[zerobyw] 发布页返回异常状态:", res.status);
      }
    } catch (error) {
      console.log("[zerobyw] 发布页不可达:", error instanceof Error ? error.message : error);
    }

    if (!publisherHtml) {
      console.log("[zerobyw] 发布页不可达，沿用当前域名:", current);
      return current;
    }

    const candidates = collectCandidates(publisherHtml);
    console.log("[zerobyw] 候选域名:", candidates.join(", ") || "(无)");

    for (const candidate of candidates) {
      const verified = await probeOrigin(candidate);
      if (verified) {
        if (verified !== current) {
          setOrigin(verified);
          await persistOrigin(verified);
          console.log("[zerobyw] 已切换域名:", current, "→", verified);
        } else {
          console.log("[zerobyw] 当前域名仍然可用:", verified);
        }
        return verified;
      }
      console.log("[zerobyw] 候选不可用:", candidate);
    }

    console.log("[zerobyw] 所有候选均不可用，沿用当前域名:", current);
    return current;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 设置页"刷新域名"动作用：强制重新发现并返回结果 */
export async function refreshOrigin(): Promise<{ origin: string; changed: boolean }> {
  const before = getOrigin();
  const after = await discoverOrigin();
  return { origin: after, changed: after !== before };
}

/** 重置回内置默认域名 */
export async function resetOriginToDefault(): Promise<string> {
  setOrigin(DEFAULT_ORIGIN);
  await persistOrigin(DEFAULT_ORIGIN);
  return DEFAULT_ORIGIN;
}
