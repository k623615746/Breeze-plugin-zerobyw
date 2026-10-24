/**
 * 站点域名状态
 *
 * 这个源站的域名会不定期更换（zerobyw33 → zerobywb → zerobywai ...），
 * 官方在 https://zerobyw.github.io/ 维护发布页。当前生效域名放在这里，
 * 供 URL 构造与解析层共用；发现逻辑见 site.ts。
 *
 * 本模块刻意不 import 任何其它模块，避免 common/http/site 之间循环依赖。
 */

/** 内置默认域名（发布页不可达时的兜底） */
export const DEFAULT_ORIGIN = "https://www.zerobyw33.com";

/** 域名有效期标记：0 表示尚未经发布页确认 */
let currentOrigin = DEFAULT_ORIGIN;

/** 归一化：补协议、去路径与尾斜杠，只保留 scheme + host */
export function normalizeOrigin(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  let value = raw.trim();
  if (!value) {
    return "";
  }
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.hostname || !parsed.hostname.includes(".")) {
      return "";
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

export function getOrigin(): string {
  return currentOrigin;
}

export function setOrigin(raw: unknown): string {
  const normalized = normalizeOrigin(raw);
  if (normalized) {
    currentOrigin = normalized;
  }
  return currentOrigin;
}

/** 换域名后重置到默认值（用于设置页"重置域名"） */
export function resetOrigin(): string {
  currentOrigin = DEFAULT_ORIGIN;
  return currentOrigin;
}

export function originHost(): string {
  try {
    return new URL(currentOrigin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 判断 host 是否属于该站族群（历史域名都带 zerobyw 字样） */
export function isSiteHost(host: string): boolean {
  const value = String(host ?? "").toLowerCase();
  if (!value || value.endsWith("github.io")) {
    return false;
  }
  return value.includes("zerobyw");
}

/**
 * 由主站域名推导图片 CDN 域名。
 * 官方规律：www.zerobyw33.com → tupa.zerobyw33.com
 */
export function deriveImageHost(mainHost: string): string {
  const bare = mainHost.replace(/^www\./i, "");
  return bare ? `tupa.${bare}` : "";
}

/** 页面特征：判定一份 HTML 是否真的是该站页面（而不是停放页 / 劫持页） */
export function looksLikeSitePage(html: string): boolean {
  if (!html) {
    return false;
  }
  return (
    html.includes("pc-manga-grid") ||
    html.includes("pc-manga-page") ||
    html.includes("zero搬运网") ||
    html.includes("zero&#25644;&#36816;&#32593;") ||
    html.includes("/pc/pc/")
  );
}

/** 常见域名停放 / 劫持页特征，用于区分"能连上但不是这个站" */
export function looksLikeParkedPage(html: string): boolean {
  if (!html) {
    return false;
  }
  const lower = html.toLowerCase();
  return (
    lower.includes("domain is for sale") ||
    lower.includes("buy this domain") ||
    lower.includes("parked domain") ||
    html.includes("域名出售") ||
    html.includes("域名已过期") ||
    html.includes("网站已关闭")
  );
}
