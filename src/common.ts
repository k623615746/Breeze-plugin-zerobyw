import { DEFAULT_ORIGIN, getOrigin, isSiteHost } from "./origin";
import type {
  ActionItem,
  ComicListItem,
  ImageItem,
  MetadataListItem,
  StringMap,
} from "breeze-plugin-kit";

/** 插件唯一标识，务必保持稳定（变更等同于新插件） */
export const PLUGIN_ID = "b7d1e0c4-3a52-4f8b-9c61-0e2a5f7d8b90";

/**
 * 占位图：必须是格式合法且可访问的非空 URL。
 * 宿主不会用它下载图片，只会校验格式，因此这里指向站点自有 logo。
 * 注意：用内置默认域名而非当前域名——图片地址可能已失效，占位图不该跟着失效。
 */
export const PLACEHOLDER_IMAGE_URL = `${DEFAULT_ORIGIN}/template/discuzx5/static/logo-zero-x5-home.svg`;

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 列表页每页条目数 */
export const PAGE_SIZE = 24;

/** 站点分类（category_id → 名称） */
export const CATEGORIES: ReadonlyArray<{ id: string; name: string }> = [
  { id: "1", name: "卖肉" },
  { id: "6", name: "后宫" },
  { id: "22", name: "冒险" },
  { id: "23", name: "奇幻" },
  { id: "13", name: "搞笑" },
  { id: "28", name: "日常" },
  { id: "35", name: "职业" },
  { id: "29", name: "体育" },
  { id: "15", name: "战斗" },
  { id: "31", name: "爱情" },
  { id: "34", name: "机战" },
  { id: "40", name: "悬疑" },
  { id: "41", name: "美食" },
  { id: "42", name: "百合" },
  { id: "43", name: "等网源" },
];

/** 语言属性筛选值 */
export const LANGS: ReadonlyArray<{ value: string; name: string }> = [
  { value: "全中文", name: "全中文" },
  { value: "全生肉", name: "全生肉" },
  { value: "一半中文一半生肉", name: "一半中文一半生肉" },
];

/** 从分类名反查分类 id 集合（用于把详情页标签归类） */
const CATEGORY_NAMES = new Set(CATEGORIES.map((c) => c.name));

const LANG_NAMES = new Set(LANGS.map((l) => l.name));

const STATUS_NAMES = new Set(["连载中", "已完结"]);

export function isCategoryName(name: string): boolean {
  return CATEGORY_NAMES.has(name);
}

export function isLanguageName(name: string): boolean {
  return LANG_NAMES.has(name);
}

export function isStatusName(name: string): boolean {
  return STATUS_NAMES.has(name);
}

/** HTML 实体解码（幂等：已是明文时原样返回） */
export function decodeEntities(input: string): string {
  if (!input || input.indexOf("&") < 0) {
    return input;
  }
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** 整理空白：压缩连续空白并去首尾 */
export function cleanText(input: string | null | undefined): string {
  if (!input) {
    return "";
  }
  return decodeEntities(input).replace(/[\s\u3000]+/g, " ").trim();
}

/** 多行文本：保留换行语义，压缩行内空白 */
export function cleanLines(input: string | null | undefined): string[] {
  if (!input) {
    return [];
  }
  return decodeEntities(input)
    .split(/\r?\n|<br\s*\/?>/i)
    .map((line) => line.replace(/[\s\u3000]+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/** 站点自有域名统一升级为 https，避免宿主侧混合内容拦截 */
function upgradeToHttps(url: string): string {
  if (!url.startsWith("http://")) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (isSiteHost(parsed.hostname)) {
      parsed.protocol = "https:";
      return parsed.toString();
    }
  } catch {
    // 解析失败时保持原样
  }
  return url;
}

/** 补全为绝对地址；处理 `//host/path`、`/path` 与已是绝对地址的情况 */
export function absoluteUrl(raw: string | null | undefined): string {
  const value = cleanText(raw);
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return upgradeToHttps(value);
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  if (value.startsWith("/")) {
    return `${getOrigin()}${value}`;
  }
  return `${getOrigin()}/${value}`;
}

/** 把任意相对地址解析为绝对 URL（用于 <base> 语义） */
export function resolveUrl(base: string, raw: string): string {
  const value = cleanText(raw);
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return upgradeToHttps(value);
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  if (value.startsWith("/")) {
    try {
      return new URL(value, base).toString();
    } catch {
      return absoluteUrl(value);
    }
  }
  try {
    return upgradeToHttps(new URL(value, base).toString());
  } catch {
    return absoluteUrl(value);
  }
}

/** 从 URL 或字符串中抽取数字（用于 kuid / zjid） */
export function extractNumber(input: string, key?: string): string {
  if (key) {
    const matched = input.match(new RegExp(`${key}=(\\d+)`));
    if (matched) {
      return matched[1];
    }
  }
  const anyNumber = input.match(/(\d+)/);
  return anyNumber ? anyNumber[1] : "";
}

export function createImage(input: {
  id?: string;
  url?: string;
  name?: string;
  path?: string;
  extern?: StringMap;
} = {}): ImageItem {
  const url = cleanText(input.url);
  return {
    id: String(input.id ?? ""),
    url: url || PLACEHOLDER_IMAGE_URL,
    name: String(input.name ?? ""),
    path: String(input.path ?? "").trim() || "cover/placeholder.png",
    extern: input.extern ?? {},
  };
}

export function createActionItem(name: string, extern: StringMap = {}): ActionItem {
  return {
    name: cleanText(name),
    onTap: null,
    extern,
  };
}

/** 生成卡片/详情页用的元信息块 */
export function createMetadata(
  type: string,
  name: string,
  values: ReadonlyArray<string>,
): MetadataListItem {
  return {
    type,
    name,
    value: values.map((item) => cleanText(item)).filter((item) => item.length > 0).map((item) => createActionItem(item)),
  };
}

/** 五位补零的页码文件名（001.jpg） */
export function padPageNo(index: number): string {
  return String(index).padStart(3, "0");
}

/** 是否为空对象 */
export function isEmptyObject(value: unknown): boolean {
  return !value || typeof value !== "object" || Object.keys(value as object).length === 0;
}

export type RawComicCard = {
  kuid: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  detailUrl: string;
};

/** 把列表卡片数据转成 ComicListItem */
export function toComicListItem(card: RawComicCard): ComicListItem {
  const coverUrl = card.coverUrl || PLACEHOLDER_IMAGE_URL;
  return {
    source: PLUGIN_ID,
    id: card.kuid,
    title: card.title,
    subtitle: card.subtitle,
    finished: false,
    likesCount: 0,
    viewsCount: 0,
    updatedAt: "",
    cover: createImage({
      id: card.kuid,
      url: coverUrl,
      name: card.title,
      path: `comic/${card.kuid}/cover.jpg`,
      extern: {},
    }),
    metadata: [],
    raw: {
      kuid: card.kuid,
      title: card.title,
      subtitle: card.subtitle,
      cover: coverUrl,
      detailUrl: card.detailUrl,
    },
    extern: {
      detailUrl: card.detailUrl,
    },
  };
}
