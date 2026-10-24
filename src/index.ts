import type {
  CapabilitiesBundleContract,
  ChapterContentContract,
  ChapterPayload,
  ComicDetailContract,
  ComicDetailPayload,
  ComicPagedListContract,
  DownloadConcurrencyResult,
  FetchImageBytesPayload,
  FilterBundleContract,
  InfoContract,
  LoginBundleContract,
  ReadSnapshotContract,
  ReadSnapshotPayload,
  SearchComicPayload,
  SearchResultContract,
  SettingsBundleContract,
} from "breeze-plugin-kit";
import { buildLoginBundle, buildUnauthorizedError, readLoginValues } from "breeze-plugin-kit";
import { CATEGORIES, LANGS, PAGE_SIZE, PLUGIN_ID, SITE_ORIGIN, cleanText, createMetadata } from "./common";
import { clearCookie, ensureCookie, fetchImage, fetchPage, hasLoginSession, saveCookie } from "./http";
import { buildPluginInfo } from "./get-info";
import {
  parseComicDetail,
  parseComicList,
  parseReader,
  toChapterPages,
  toChapterSummaries,
  type ReaderParsed,
} from "./parse";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function buildListPath(params: {
  page: number;
  keyword?: string;
  categoryId?: string;
  order?: string;
  dir?: string;
  jindu?: string;
  shuxing?: string;
}): string {
  const search = new URLSearchParams();
  search.set("page", String(params.page));
  if (params.keyword) {
    search.set("keyword", params.keyword);
  }
  if (params.categoryId) {
    search.set("category_id", params.categoryId);
  }
  if (params.order) {
    search.set("order", params.order);
  }
  if (params.dir) {
    search.set("dir", params.dir);
  }
  if (params.jindu) {
    search.set("jindu", params.jindu);
  }
  if (params.shuxing) {
    search.set("shuxing", params.shuxing);
  }
  return `${SITE_ORIGIN}/pc/pc/?${search.toString()}`;
}

/** 章节被站点登录墙拦截时，抛标准 unauthorized 让宿主引导登录 */
function raiseLoginRequired(message: string): never {
  throw buildUnauthorizedError(PLUGIN_ID, message);
}

/** 解析阅读页并做登录墙判断 */
async function loadReader(chapterId: string): Promise<ReaderParsed> {
  if (!chapterId) {
    throw new Error("缺少章节标识，无法加载阅读页");
  }
  const htmlText = await fetchPage(`${SITE_ORIGIN}/pc/view/index.php?zjid=${encodeURIComponent(chapterId)}`);
  const parsed = parseReader(htmlText, chapterId);
  if (parsed.imageUrls.length === 0) {
    if (parsed.needLogin) {
      raiseLoginRequired("该章节需要登录 zero搬运网 账号后才能阅读，请先在插件设置中登录（填入 Cookie）。");
    }
    throw new Error("未解析到章节图片，站点结构可能已调整。");
  }
  return parsed;
}

/** 拉取某漫画的完整目录：详情页只暴露部分章节，阅读页目录才是全集 */
async function loadCatalog(comicId: string, firstChapterId: string) {
  if (!firstChapterId) {
    return { entries: [], reader: null as ReaderParsed | null };
  }
  const reader = await loadReader(firstChapterId);
  return { entries: reader.catalog, reader };
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function init(): Promise<{ source: string; data: { ok: boolean } }> {
  await ensureCookie();
  console.log("[zerobyw] init");
  return { source: PLUGIN_ID, data: { ok: true } };
}

// ---------------------------------------------------------------------------
// getInfo
// ---------------------------------------------------------------------------

async function getInfo(): Promise<InfoContract> {
  return buildPluginInfo();
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

async function searchComic(payload: SearchComicPayload): Promise<SearchResultContract> {
  const keyword = cleanText(payload.keyword);
  const page = toNumber(payload.page, 1);

  if (!keyword) {
    return {
      source: PLUGIN_ID,
      extern: null,
      scheme: { version: "1.0.0", type: "searchResult", source: PLUGIN_ID, list: "grid" },
      data: {
        paging: { page: 1, pages: 1, total: 0, hasReachedMax: true },
        items: [],
      },
      paging: { page: 1, pages: 1, total: 0, hasReachedMax: true },
      items: [],
    };
  }

  const htmlText = await fetchPage(buildListPath({ page, keyword }));
  const { cards, totalPages } = parseComicList(htmlText, page);

  const items = cards.map((card) => ({
    source: PLUGIN_ID,
    id: card.kuid,
    title: card.title,
    subtitle: card.subtitle,
    finished: false,
    likesCount: 0,
    viewsCount: 0,
    updatedAt: "",
    cover: {
      id: card.kuid,
      url: card.coverUrl || `${SITE_ORIGIN}/favicon.ico`,
      name: card.title,
      path: `comic/${card.kuid}/cover.jpg`,
      extern: {},
    },
    metadata: [],
    raw: { kuid: card.kuid, detailUrl: card.detailUrl },
    extern: { detailUrl: card.detailUrl },
  }));

  const paging = {
    page,
    pages: totalPages,
    total: totalPages * PAGE_SIZE,
    hasReachedMax: page >= totalPages,
  };

  return {
    source: PLUGIN_ID,
    extern: null,
    scheme: { version: "1.0.0", type: "searchResult", source: PLUGIN_ID, list: "grid" },
    data: { paging, items },
    paging,
    items,
  };
}

// ---------------------------------------------------------------------------
// 列表（发现页入口 / 筛选后的分页列表）
// ---------------------------------------------------------------------------

async function getRankingData(payload: SearchComicPayload): Promise<ComicPagedListContract> {
  const extern = (payload.extern ?? {}) as Record<string, unknown>;
  const record = payload as unknown as Record<string, unknown>;
  const page = toNumber(payload.page, 1);

  const categoryId = pickString(extern.categoryId, extern.category_id);
  const order = pickString(extern.order, record.order);
  const dir = pickString(extern.dir, record.dir);
  const jindu = pickString(extern.jindu, record.jindu);
  const shuxing = pickString(extern.shuxing, record.shuxing);

  const htmlText = await fetchPage(
    buildListPath({ page, categoryId, order, dir, jindu, shuxing }),
  );
  const { cards, totalPages } = parseComicList(htmlText, page);

  return {
    source: PLUGIN_ID,
    extern: null,
    data: {
      items: cards.map((card) => ({
        source: PLUGIN_ID,
        id: card.kuid,
        title: card.title,
        subtitle: card.subtitle,
        finished: false,
        likesCount: 0,
        viewsCount: 0,
        updatedAt: "",
        cover: {
          id: card.kuid,
          url: card.coverUrl || `${SITE_ORIGIN}/favicon.ico`,
          name: card.title,
          path: `comic/${card.kuid}/cover.jpg`,
          extern: {},
        },
        metadata: [],
        raw: { kuid: card.kuid, detailUrl: card.detailUrl },
        extern: { detailUrl: card.detailUrl },
      })),
      hasReachedMax: page >= totalPages,
    },
  };
}

async function getRankingFilterBundle(): Promise<FilterBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "rankingFilter",
      title: "筛选漫画",
      fields: [
        {
          key: "category",
          kind: "choice",
          label: "分类",
          options: [
            { label: "全部", value: "", result: { extern: { categoryId: "" } } },
            ...CATEGORIES.map((category) => ({
              label: category.name,
              value: category.id,
              result: { extern: { categoryId: category.id } },
            })),
          ],
        },
        {
          key: "progress",
          kind: "choice",
          label: "进度",
          options: [
            { label: "全部", value: "", result: { extern: { jindu: "" } } },
            { label: "连载中", value: "0", result: { extern: { jindu: "0" } } },
            { label: "已完结", value: "1", result: { extern: { jindu: "1" } } },
          ],
        },
        {
          key: "language",
          kind: "choice",
          label: "语言",
          options: [
            { label: "全部", value: "", result: { extern: { shuxing: "" } } },
            ...LANGS.map((lang) => ({
              label: lang.name,
              value: lang.value,
              result: { extern: { shuxing: lang.value } },
            })),
          ],
        },
        {
          key: "sort",
          kind: "choice",
          label: "排序",
          options: [
            { label: "最新上架", value: "addtime_desc", result: { extern: { order: "addtime", dir: "desc" } } },
            { label: "最早上架", value: "addtime_asc", result: { extern: { order: "addtime", dir: "asc" } } },
            { label: "人气最高", value: "views_desc", result: { extern: { order: "views", dir: "desc" } } },
            { label: "收藏最多", value: "favores_desc", result: { extern: { order: "favores", dir: "desc" } } },
          ],
        },
      ],
    },
    data: {
      values: {
        category: "",
        progress: "",
        language: "",
        sort: "addtime_desc",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

async function getComicDetail(payload: ComicDetailPayload): Promise<ComicDetailContract> {
  const comicId = cleanText(payload.comicId);
  if (!comicId) {
    throw new Error("缺少漫画 ID");
  }

  const htmlText = await fetchPage(`${SITE_ORIGIN}/pc/details/?kuid=${encodeURIComponent(comicId)}`);
  const detail = parseComicDetail(htmlText, comicId);

  let chapters = [] as ReturnType<typeof toChapterSummaries>;
  let catalogNote = "";
  if (detail.firstChapterId) {
    try {
      const { entries } = await loadCatalog(comicId, detail.firstChapterId);
      chapters = toChapterSummaries(entries, comicId);
    } catch (error) {
      catalogNote = error instanceof Error ? error.message : "目录加载失败";
    }
  }

  // 目录拿不到时退回详情页可见的少量章节
  if (chapters.length === 0 && detail.firstChapterId) {
    chapters = toChapterSummaries([{ zjid: detail.firstChapterId, name: "第 1 话" }], comicId);
  }

  const metadata = [
    createMetadata("author", "作者", detail.author ? [detail.author] : []),
    createMetadata("categories", "分类", detail.categories),
    createMetadata("tags", "语言", detail.languages),
    createMetadata("works", "状态", detail.status ? [detail.status] : []),
  ];

  const descriptionParts = [detail.description];
  if (catalogNote) {
    descriptionParts.push(`\n\n（章节说明：${catalogNote}）`);
  }

  return {
    source: PLUGIN_ID,
    comicId,
    extern: null,
    scheme: { version: "1.0.0", type: "comicDetail", source: PLUGIN_ID },
    data: {
      normal: {
        comicInfo: {
          id: comicId,
          title: detail.title,
          titleMeta: [],
          creator: {
            id: "",
            name: detail.author,
            avatar: { id: "", url: "", name: "", path: "", extern: {} },
            onTap: null,
            extern: {},
          },
          description: descriptionParts.join(""),
          cover: {
            id: comicId,
            url: detail.coverUrl || `${SITE_ORIGIN}/favicon.ico`,
            name: detail.title,
            path: `comic/${comicId}/cover.jpg`,
            extern: {},
          },
          metadata,
          extern: { detailUrl: `${SITE_ORIGIN}/pc/details/?kuid=${comicId}` },
        },
        preview: { enabled: false },
        eps: chapters,
        recommend: [],
        totalViews: detail.viewsCount,
        totalLikes: detail.likesCount,
        totalComments: 0,
        isFavourite: false,
        isLiked: false,
        allowComments: false,
        allowLike: false,
        allowCollected: true,
        allowDownload: true,
        allowCommentsReason: "站点评论位于独立论坛，插件未接入",
        allowLikeReason: "站点未提供点赞接口",
        extern: {},
      },
      raw: {
        kuid: comicId,
        subtitle: detail.subtitle,
        status: detail.status,
        categories: detail.categories,
        languages: detail.languages,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 阅读
// ---------------------------------------------------------------------------

async function buildReaderData(comicId: string, chapterId: string) {
  const reader = await loadReader(chapterId);
  const resolvedComicId = comicId || reader.chapterId;
  const chapters = toChapterSummaries(reader.catalog, resolvedComicId);
  const chapterSummary =
    chapters.find((chapter) => chapter.requestId === chapterId) ??
    ({
      id: chapterId,
      requestId: chapterId,
      logicalKey: `${resolvedComicId}-${chapterId}`,
      storageChapterId: chapterId,
      name: reader.chapterName,
      order: 1,
      extern: { zjid: chapterId },
    } as (typeof chapters)[number]);

  return {
    reader,
    chapters,
    chapter: {
      ...chapterSummary,
      name: reader.chapterName || chapterSummary.name,
      pages: toChapterPages(reader.imageUrls, resolvedComicId, chapterId),
    },
  };
}

async function getReadSnapshot(payload: ReadSnapshotPayload): Promise<ReadSnapshotContract> {
  const comicId = cleanText(payload.comicId);
  const chapterId = String(payload.chapterId ?? "").trim();
  const { reader, chapters, chapter } = await buildReaderData(comicId, chapterId);

  return {
    source: PLUGIN_ID,
    extern: null,
    data: {
      comic: {
        id: comicId,
        source: PLUGIN_ID,
        title: reader.comicTitle || `漫画 ${comicId}`,
        extern: {},
      },
      chapter,
      chapters,
    },
  };
}

async function getChapter(payload: ChapterPayload): Promise<ChapterContentContract> {
  const comicId = cleanText(payload.comicId);
  const chapterId = String(payload.chapterId ?? "").trim();
  const { reader, chapters, chapter } = await buildReaderData(comicId, chapterId);

  return {
    source: PLUGIN_ID,
    comicId,
    chapterId,
    extern: null,
    scheme: { version: "1.0.0", type: "chapterContent", source: PLUGIN_ID },
    data: {
      comic: {
        id: comicId,
        source: PLUGIN_ID,
        title: reader.comicTitle || `漫画 ${comicId}`,
        extern: {},
      },
      chapter,
      chapters,
    },
  };
}

async function fetchImageBytes(payload: FetchImageBytesPayload): Promise<Uint8Array> {
  const url = cleanText(payload.url);
  if (!url) {
    throw new Error("图片地址为空");
  }
  return fetchImage(url, payload.timeoutMs ?? 30000);
}

async function getDownloadConcurrency(): Promise<DownloadConcurrencyResult> {
  return { concurrency: 3 };
}

// ---------------------------------------------------------------------------
// 设置 / 登录 / 能力
// ---------------------------------------------------------------------------

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  const cookie = await ensureCookie();
  const loggedIn = hasLoginSession(cookie);
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: [
        {
          id: "about",
          title: loggedIn ? "登录状态：已配置 Cookie" : "登录状态：未登录（仅可阅读免费章节）",
          fields: [],
        },
      ],
    },
    data: {
      canShowUserInfo: false,
      canLogin: true,
      loginTitle: "Cookie 登录",
      loginSubtitle: "粘贴浏览器 Cookie 以解锁全部章节",
      values: {},
    },
  };
}

async function getLoginBundle(): Promise<LoginBundleContract> {
  return buildLoginBundle(PLUGIN_ID, {
    title: "zero搬运网 Cookie 登录",
    fields: [
      {
        key: "cookie",
        kind: "multiline",
        label: "Cookie",
        required: true,
        placeholder: "从浏览器开发者工具复制完整 Cookie",
        help: "登录站点后按 F12 → 网络 → 任选请求 → 复制请求头里的 Cookie。仅保存在本机插件配置中。",
      },
    ],
    submitFnPath: "loginWithCookie",
    submitText: "保存并验证",
  });
}

/** 用 /pc/pcmy/ 页面判断登录态 */
async function detectLoginState(): Promise<{ loggedIn: boolean; hint: string }> {
  try {
    const htmlText = await fetchPage(`${SITE_ORIGIN}/pc/pcmy/?tab=fav`);
    const hasLogout = /action=logout|act=logout|退出/.test(htmlText);
    const hasLoginForm = /action=login/.test(htmlText);
    if (hasLogout) {
      return { loggedIn: true, hint: "登录成功" };
    }
    if (hasLoginForm) {
      return { loggedIn: false, hint: "Cookie 无效或已过期" };
    }
    return { loggedIn: true, hint: "已保存，未检测到明显的未登录提示" };
  } catch {
    return { loggedIn: true, hint: "Cookie 已保存（未能自动验证）" };
  }
}

async function loginWithCookie(payload?: Record<string, unknown>) {
  const values = readLoginValues(payload as never);
  const raw = values.cookie ?? values.Cookie ?? "";
  const normalized = await saveCookie(raw);
  if (!normalized) {
    throw new Error("Cookie 不能为空");
  }
  const state = await detectLoginState();
  if (!state.loggedIn) {
    throw new Error(state.hint);
  }
  return {
    source: PLUGIN_ID,
    message: state.hint,
    data: { message: state.hint },
  };
}

async function clearCookieAction() {
  await clearCookie();
  return { source: PLUGIN_ID, data: { ok: true, message: "已清除登录 Cookie" } };
}

async function checkLoginState() {
  await ensureCookie();
  const state = await detectLoginState();
  return { source: PLUGIN_ID, data: { ok: state.loggedIn, message: state.hint } };
}

async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "capabilities",
      actions: [
        { key: "check", title: "检查登录状态", fnPath: "checkLoginState" },
        { key: "clear", title: "清除登录 Cookie", fnPath: "clearCookieAction" },
      ],
    },
    data: {},
  };
}

export default {
  init,
  getInfo,
  searchComic,
  getRankingData,
  getRankingFilterBundle,
  getComicDetail,
  getReadSnapshot,
  getChapter,
  fetchImageBytes,
  getDownloadConcurrency,
  getSettingsBundle,
  getLoginBundle,
  loginWithCookie,
  clearCookieAction,
  checkLoginState,
  getCapabilitiesBundle,
};
