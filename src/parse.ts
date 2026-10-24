import type { ChapterSummary } from "breeze-plugin-kit";
import {
  PLUGIN_ID,
  absoluteUrl,
  cleanLines,
  cleanText,
  createActionItem,
  createImage,
  createMetadata,
  extractNumber,
  isCategoryName,
  isLanguageName,
  isStatusName,
  padPageNo,
  type RawComicCard,
} from "./common";

type Node = unknown;

type Selection = {
  length: number;
  attr: (name: string) => string | undefined;
  text: () => string;
  html: () => string;
  find: (selector: string) => Selection;
  first: () => Selection;
  eq: (index: number) => Selection;
  map: <T>(fn: (index: number, element: Node) => T) => { get: () => T[] };
  each: (fn: (index: number, element: Node) => void) => void;
  toArray: () => Node[];
};

type HtmlApi = ((selector: string | Node) => Selection) & {
  load: (html: string) => HtmlApi;
};

function html(): HtmlApi {
  return (globalThis as unknown as { BreezeHtml: HtmlApi }).BreezeHtml;
}

function load(htmlText: string): HtmlApi {
  return html().load(htmlText);
}

/** BreezeHtml 对 Selection.length 的支持不完全稳定，优先用 toArray() 计算长度 */
function size(selection: Selection): number {
  const raw = (selection as unknown as { length?: unknown }).length;
  if (typeof raw === "number") {
    return raw;
  }
  try {
    return selection.toArray().length;
  } catch {
    return 0;
  }
}

function textOf(selection: Selection): string {
  return cleanText(selection.text());
}

function attrOf(selection: Selection, name: string): string {
  return cleanText(selection.attr(name) ?? "");
}

function collectCards(htmlText: string): RawComicCard[] {
  const $ = load(htmlText);
  const cards: RawComicCard[] = [];
  const seen = new Set<string>();

  $(".pc-manga-grid a").each((_, element) => {
    const $a = $(element);
    const href = attrOf($a, "href");
    if (!href.includes("kuid=")) {
      return;
    }
    const kuid = extractNumber(href, "kuid");
    if (!kuid || seen.has(kuid)) {
      return;
    }
    seen.add(kuid);

    const title = textOf($a.find(".manga-card-title"));
    const subtitle = textOf($a.find(".manga-card-meta"));
    const coverUrl = absoluteUrl(attrOf($a.find("img").first(), "src"));
    if (!title && !coverUrl) {
      return;
    }

    cards.push({
      kuid,
      title: title || `未命名-${kuid}`,
      subtitle,
      coverUrl,
      detailUrl: absoluteUrl(href),
    });
  });

  // 兜底：页面结构变动时按链接直接抓
  if (cards.length === 0) {
    $("a").each((_, element) => {
      const $a = $(element);
      const href = attrOf($a, "href");
      if (!href.includes("kuid=")) {
        return;
      }
      const kuid = extractNumber(href, "kuid");
      if (!kuid || seen.has(kuid)) {
        return;
      }
      seen.add(kuid);
      const title = textOf($a);
      cards.push({
        kuid,
        title: title || `未命名-${kuid}`,
        subtitle: "",
        coverUrl: absoluteUrl(attrOf($a.find("img").first(), "src")),
        detailUrl: absoluteUrl(href),
      });
    });
  }

  return cards;
}

export type ComicListPage = {
  cards: RawComicCard[];
  totalPages: number;
};

/** 解析列表页 / 搜索结果页 */
export function parseComicList(htmlText: string, currentPage: number): ComicListPage {
  const cards = collectCards(htmlText);
  const $ = load(htmlText);

  let totalPages = 0;
  $("a").each((_, element) => {
    const href = attrOf($(element), "href");
    if (!href.includes("page=")) {
      return;
    }
    const page = Number(extractNumber(href, "page"));
    if (Number.isFinite(page) && page > totalPages) {
      totalPages = page;
    }
  });

  if (!Number.isFinite(totalPages) || totalPages <= 0) {
    totalPages = cards.length >= 24 ? currentPage + 1 : currentPage;
  }
  if (totalPages < currentPage) {
    totalPages = currentPage;
  }

  return { cards, totalPages };
}

export type ComicDetailParsed = {
  comicId: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  author: string;
  description: string;
  categories: string[];
  languages: string[];
  status: string;
  likesCount: number;
  viewsCount: number;
  firstChapterId: string;
  finished: boolean;
};

/** 解析漫画详情页 */
export function parseComicDetail(htmlText: string, comicId: string): ComicDetailParsed {
  const $ = load(htmlText);
  const scope = size($("main")) > 0 ? $("main").first() : $("body").first();

  const titleLines = cleanLines(scope.find("h1").first().html() ?? scope.find("h1").first().text());
  const title = titleLines[0] ?? "";
  const subtitle = titleLines.slice(1).join(" ");

  const coverUrl = absoluteUrl(attrOf(scope.find("img").first(), "src"));

  const description = cleanText(
    (size(scope.find("p[x-ref='summaryText']")) > 0
      ? scope.find("p[x-ref='summaryText']").first()
      : scope.find("p").first()
    ).text(),
  );

  const tags: string[] = [];
  scope.find("span").each((_, element) => {
    const value = textOf($(element));
    if (!value || value.length > 40) {
      return;
    }
    if (!tags.includes(value)) {
      tags.push(value);
    }
  });

  let author = "";
  const categories: string[] = [];
  const languages: string[] = [];
  let status = "";
  let likesCount = 0;
  let viewsCount = 0;

  for (const tag of tags) {
    const authorMatch = tag.match(/^作\s*者\s*[:：]\s*(.+)$/);
    if (authorMatch) {
      author = cleanText(authorMatch[1]);
      continue;
    }
    const favMatch = tag.match(/^收藏\s*[:：]\s*(\d+)/);
    if (favMatch) {
      likesCount = Number(favMatch[1]) || 0;
      continue;
    }
    const viewMatch = tag.match(/^(?:人气|浏览)\s*[:：]\s*(\d+)/);
    if (viewMatch) {
      viewsCount = Number(viewMatch[1]) || 0;
      continue;
    }
    if (isStatusName(tag)) {
      status = tag;
      continue;
    }
    if (isLanguageName(tag)) {
      languages.push(tag);
      continue;
    }
    if (isCategoryName(tag)) {
      categories.push(tag);
    }
  }

  let firstChapterId = "";
  scope.find("a").each((_, element) => {
    if (firstChapterId) {
      return;
    }
    const href = attrOf($(element), "href");
    const chapterId = extractNumber(href, "zjid");
    if (chapterId) {
      firstChapterId = chapterId;
    }
  });

  return {
    comicId,
    title: title || cleanText($("title").first().text()).split("-")[0] || `未命名-${comicId}`,
    subtitle,
    coverUrl,
    author,
    description,
    categories,
    languages,
    status,
    likesCount,
    viewsCount,
    firstChapterId,
    finished: status === "已完结",
  };
}

const NAV_WORDS = ["上一话", "下一话", "上一章", "下一章", "上一頁", "下一頁", "上一页", "下一页", "目录", "目錄", "返回"];

/** 判断目录链接的文本是否像章节名 */
function looksLikeChapterName(text: string): boolean {
  if (!text) {
    return false;
  }
  if (NAV_WORDS.some((word) => text.includes(word))) {
    return false;
  }
  if (text.length > 24) {
    return false;
  }
  return /^[\d０-９]+([-~～—至][\d０-９]+)?(话|話|章|卷)?$/.test(text);
}

export type CatalogEntry = {
  zjid: string;
  name: string;
};

/** 从阅读页的目录弹层解析完整章节列表 */
export function parseCatalog(htmlText: string): CatalogEntry[] {
  const $ = load(htmlText);
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();

  $("a").each((_, element) => {
    const $a = $(element);
    const href = attrOf($a, "href");
    if (!href.includes("zjid=")) {
      return;
    }
    const zjid = extractNumber(href, "zjid");
    if (!zjid || seen.has(zjid)) {
      return;
    }
    const name = textOf($a);
    if (!looksLikeChapterName(name)) {
      return;
    }
    seen.add(zjid);
    entries.push({ zjid, name });
  });

  return entries;
}

export type ReaderParsed = {
  comicTitle: string;
  chapterName: string;
  chapterId: string;
  imageUrls: string[];
  prevChapterId: string;
  nextChapterId: string;
  catalog: CatalogEntry[];
  needLogin: boolean;
};

/** 解析阅读页：图片列表 + 章节上下文 */
export function parseReader(htmlText: string, chapterId: string): ReaderParsed {
  const $ = load(htmlText);

  const pageTitle = cleanText($("title").first().text());
  const titleParts = pageTitle
    .split(/\s*[-–—]\s*/)
    .map((part) => cleanText(part))
    .filter((part) => part.length > 0);
  const siteSuffix = titleParts.length > 1 ? titleParts[titleParts.length - 1] : "";
  const hasSiteSuffix = siteSuffix.includes("搬运") || siteSuffix.includes("zero");
  const effective = hasSiteSuffix ? titleParts.slice(0, -1) : titleParts;
  const chapterName = effective.length >= 2 ? effective[effective.length - 1] : "";
  const comicTitle = effective.length >= 2 ? effective.slice(0, -1).join(" - ") : (effective[0] ?? "");

  const imageUrls: string[] = [];
  $("img.manga-image").each((_, element) => {
    const src = attrOf($(element), "src");
    const url = absoluteUrl(src);
    if (url && !imageUrls.includes(url)) {
      imageUrls.push(url);
    }
  });

  // 兜底：部分页面用 data-src / data-original 懒加载
  if (imageUrls.length === 0) {
    $("img").each((_, element) => {
      const $img = $(element);
      const raw = attrOf($img, "data-src") || attrOf($img, "data-original") || attrOf($img, "src");
      if (!raw.includes("tupa") && !/\.(?:jpe?g|png|webp|avif)/i.test(raw)) {
        return;
      }
      const url = absoluteUrl(raw);
      if (url && !imageUrls.includes(url)) {
        imageUrls.push(url);
      }
    });
  }

  const prevMatch = htmlText.match(/prevChapterUrl\s*=\s*["']([^"']*)["']/);
  const nextMatch = htmlText.match(/nextChapterUrl\s*=\s*"([^"]*)"/) ?? htmlText.match(/nextChapterUrl\s*=\s*'([^']*)'/);
  const prevChapterId = prevMatch ? extractNumber(prevMatch[1], "zjid") : "";
  const nextChapterId = nextMatch ? extractNumber(nextMatch[1], "zjid") : "";

  const needLogin = imageUrls.length === 0 && /需要登录|請先登入|请先登录|VIP 专属/.test(htmlText);

  return {
    comicTitle,
    chapterName: chapterName || `章节 ${chapterId}`,
    chapterId,
    imageUrls,
    prevChapterId,
    nextChapterId,
    catalog: parseCatalog(htmlText),
    needLogin,
  };
}

/** 把目录条目转成宿主要求的章节结构 */
export function toChapterSummaries(entries: CatalogEntry[], comicId: string): ChapterSummary[] {
  return entries.map((entry, index) => {
    const safeId = entry.zjid;
    return {
      id: safeId,
      requestId: safeId,
      logicalKey: `${comicId}-${safeId}`,
      storageChapterId: safeId,
      name: entry.name,
      order: index + 1,
      extern: { zjid: safeId },
    };
  });
}

/** 构造章节页列表 */
export function toChapterPages(imageUrls: string[], comicId: string, chapterId: string) {
  return imageUrls.map((url, index) => {
    const pageNo = padPageNo(index + 1);
    return {
      id: `${chapterId}-${pageNo}`,
      name: `${pageNo}.jpg`,
      path: `comic/${comicId}/${chapterId}/${pageNo}.jpg`,
      url,
      extern: { index: index + 1 },
    };
  });
}

export { createActionItem, createImage, createMetadata, PLUGIN_ID };
export type { RawComicCard };
