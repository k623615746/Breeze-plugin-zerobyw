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
  UserInfoBundleContract,
} from "breeze-plugin-kit";
import { authConfig, buildLoginBundle, buildUnauthorizedError, readLoginValues } from "breeze-plugin-kit";
import { CATEGORIES, LANGS, PAGE_SIZE, PLACEHOLDER_IMAGE_URL, PLUGIN_ID, cleanText, createMetadata } from "./common";
import { clearCookie, ensureCookie, fetchImage, fetchSitePath, getSessionCookie, hasLoginSession, saveCookie } from "./http";
import { getOrigin } from "./origin";
import { refreshOrigin, resetOriginToDefault } from "./site";
import { loginWithAccount as performAccountLogin, loginWithSavedAccount, getSavedAccount } from "./login";
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
  return `/pc/pc/?${search.toString()}`;
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
  const htmlText = await fetchSitePath(`/pc/view/index.php?zjid=${encodeURIComponent(chapterId)}`);
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
  console.log("[zerobyw] init，当前域名:", getOrigin());
  // 学习 copyComic：有保存的账号密码时自动续登。先探测登录态，
  // 已登录则跳过（省一次登录请求，也避免触发站点限流）。
  try {
    const state = await detectLoginState();
    if (!state.loggedIn) {
      const saved = await getSavedAccount();
      if (saved.username && saved.password) {
        console.log("[zerobyw] 登录态失效，用保存的账号自动续登");
        await loginWithSavedAccount();
      }
    }
  } catch (error) {
    // 自动续登失败不阻塞 init（无账号/未登录也能浏览免费内容）
    console.warn("[zerobyw] init 自动续登失败:", error);
  }
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

  const htmlText = await fetchSitePath(buildListPath({ page, keyword }));
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
      url: card.coverUrl || PLACEHOLDER_IMAGE_URL,
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

  const htmlText = await fetchSitePath(
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
          url: card.coverUrl || PLACEHOLDER_IMAGE_URL,
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

  const htmlText = await fetchSitePath(`/pc/details/?kuid=${encodeURIComponent(comicId)}`);
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
            url: detail.coverUrl || PLACEHOLDER_IMAGE_URL,
            name: detail.title,
            path: `comic/${comicId}/cover.jpg`,
            extern: {},
          },
          metadata,
          extern: { detailUrl: `${getOrigin()}/pc/details/?kuid=${comicId}` },
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
          id: "domain",
          title: `当前域名：${getOrigin()}`,
          fields: [],
        },
        {
          id: "about",
          title: loggedIn ? "登录状态：已登录" : "登录状态：未登录（仅可阅读免费章节）",
          fields: [],
        },
      ],
    },
    data: {
      // 已登录才展示用户信息入口（学习 JmComic：canShowUserInfo + getUserInfoBundle）
      canShowUserInfo: loggedIn,
      canLogin: true,
      loginTitle: "账号登录",
      loginSubtitle: "用账号密码登录，解锁全部章节",
      values: {},
    },
  };
}

async function getLoginBundle(): Promise<LoginBundleContract> {
  // 回填上次登录的账号（学习 copyComic：values 带 username）
  let savedUsername = "";
  try {
    savedUsername = (await getSavedAccount()).username;
  } catch {
    savedUsername = "";
  }
  return buildLoginBundle(PLUGIN_ID, {
    title: "zero搬运网 账号登录",
    fields: [
      {
        key: "username",
        kind: "text",
        label: "账号",
        required: true,
        placeholder: "用户名 / UID / 邮箱",
        help: "支持 Discuz 的用户名、UID、邮箱三种登录方式，默认按用户名。",
      },
      {
        key: "password",
        kind: "password",
        label: "密码",
        required: true,
        placeholder: "登录密码",
      },
      {
        key: "questionid",
        kind: "text",
        label: "安全提问编号（可选）",
        placeholder: "没有设置安全提问请留空",
        help: "若账号设置了安全提问，填对应编号：1 母亲的名字 / 2 爷爷的名字 / 3 父亲出生的城市 / 4 老师的名字 / 5 计算机型号 / 6 喜欢的餐馆 / 7 驾照后四位。",
      },
      {
        key: "answer",
        kind: "text",
        label: "安全提问答案（可选）",
        placeholder: "与上面编号对应的答案",
      },
    ],
    submitFnPath: "loginWithAccount",
    submitText: "登录",
    values: savedUsername ? { username: savedUsername } : {},
  });
}

/**
 * 网页登录（学习 Breeze 宿主的 PluginWebLoginFlow 机制）：
 * 返回 openUrl + setCookieFnPath 配置，宿主打开内置 WebView，
 * 用户在网页里完成登录后，宿主持把 WebView 的 cookie 通过
 * saveWebLoginCookie 回传本插件，实现「插件内跳转网页登录」。
 */
async function startWebLogin() {
  await ensureCookie();
  const origin = getOrigin();
  return {
    source: PLUGIN_ID,
    message: "请在打开的网页中完成登录，成功后会自动同步",
    data: {
      openTitle: "zero搬运网 网页登录",
      openUrl: `${origin}/member.php?mod=logging&action=login`,
      setCookieFnPath: "saveWebLoginCookie",
      // Discuz 登录成功后会跳转回站点首页，以此作为「登录完成」的判定
      redirectWatchUrl: `${origin}/`,
    },
  };
}

/** 宿主 WebView 登录成功后回传 cookie（core: { cookie, url }） */
async function saveWebLoginCookie(payload?: Record<string, unknown>) {
  const record = (payload ?? {}) as Record<string, unknown>;
  // 宿主经 core 传参，值出现在 payload 顶层；同时兼容 values.cookie（登录表单路径）
  const values = (record.values ?? {}) as Record<string, unknown>;
  const raw = String(record.cookie ?? values.cookie ?? "").trim();
  if (!raw) {
    throw new Error("未收到网页登录的 Cookie");
  }
  await saveCookie(raw);
  const state = await detectLoginState();
  if (!state.loggedIn) {
    throw new Error(state.hint || "网页登录未成功，请重试");
  }
  return {
    source: PLUGIN_ID,
    message: "网页登录成功，登录态已同步",
    data: { message: "网页登录成功", loggedIn: true },
  };
}

/**
 * 用户信息（学习 JmComic 的 UserInfoBundle）：登录后设置页展示账号。
 * Discuz 的用户名在登录态页面里（pcmy 标题/欢迎语），提取不到时给出降级信息。
 */
async function getUserInfoBundle(): Promise<UserInfoBundleContract> {
  await ensureCookie();
  let username = "";
  let uid = "";
  try {
    const html = await fetchSitePath(`/pc/pcmy/?tab=fav`);
    uid = html.match(/discuz_uid\s*=\s*'(\d+)'/)?.[1] ?? "";
    username =
      cleanText(html.match(/欢迎您回来[，,\s]*<[^>]*>([^<]+)</)?.[1] ?? "") ||
      cleanText(html.match(/<strong[^>]*>([^<]{1,30})<\/strong>/)?.[1] ?? "");
  } catch {
    // 页面抓取失败时退回保存的账号
  }
  if (!username) {
    username = (await getSavedAccount()).username;
  }
  if (!username) {
    throw buildUnauthorizedError(PLUGIN_ID, "未登录，请先登录");
  }
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0", type: "userInfo" },
    data: {
      title: "账号",
      avatar: { id: uid || "me", url: "", name: username, path: "", extern: {} },
      lines: [uid ? `${username}（UID ${uid}）` : username],
      extern: { uid },
    },
  };
}

/** 备用：直接用 Cookie 登录（站点弹出验证码时走这条路） */
async function getCookieLoginBundle(): Promise<LoginBundleContract> {
  return buildLoginBundle(PLUGIN_ID, {
    title: "zero搬运网 Cookie 登录（备用）",
    fields: [
      {
        key: "cookie",
        kind: "multiline",
        label: "Cookie",
        required: true,
        placeholder: "从浏览器开发者工具复制完整 Cookie",
        help: "若账号登录提示需要验证码，可先在浏览器登录，再按 F12 → 网络 → 任选请求 → 复制请求头里的 Cookie 粘贴到这里。",
      },
    ],
    submitFnPath: "loginWithCookie",
    submitText: "保存并验证",
  });
}

/** 账号密码登录入口 */
async function loginWithAccount(payload?: Record<string, unknown>) {
  const values = readLoginValues(payload as never);
  const result = await performAccountLogin({
    username: values.username ?? "",
    password: values.password ?? "",
    questionid: values.questionid ?? "",
    answer: values.answer ?? "",
  });

  // 登录成功后顺带确认一次站点登录态
  const state = await detectLoginState();
  const message = state.loggedIn ? result.message : `${result.message}（但站点未确认登录态：${state.hint}）`;

  return {
    source: PLUGIN_ID,
    message,
    data: { message, cookieCount: result.cookieCount },
  };
}

/** 用 /pc/pcmy/ 页面判断登录态（auth cookie 为决定性证据，页面特征为辅） */
async function detectLoginState(): Promise<{ loggedIn: boolean; hint: string }> {
  try {
    const htmlText = await fetchSitePath(`/pc/pcmy/?tab=fav`);
    const hasLogout = /action=logout|act=logout|退出/.test(htmlText);
    const hasLoginForm = /action=login/.test(htmlText);
    // Discuz 登录成功必下发 _auth cookie——这是登录态的充要条件。
    // 页面特征为辅：有些未登录请求带 session 时不跳登录页（无 action=login），
    // 不能因此误判为已登录。
    const hasAuth = /(?:^|;\s*)[^;]*_auth=/i.test(getSessionCookie());
    if (hasAuth) {
      return { loggedIn: true, hint: "登录成功" };
    }
    if (hasLoginForm) {
      return { loggedIn: false, hint: "登录已失效或未登录" };
    }
    if (hasLogout) {
      return { loggedIn: true, hint: "已登录" };
    }
    return { loggedIn: false, hint: "登录已失效或未登录" };
  } catch {
    // 页面探测失败时退回 cookie 判定：有 auth 算已登录，否则保守视为未登录
    const hasAuth = /(?:^|;\s*)[^;]*_auth=/i.test(getSessionCookie());
    return hasAuth
      ? { loggedIn: true, hint: "登录态已保存（未能自动验证）" }
      : { loggedIn: false, hint: "登录已失效或未登录" };
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

/** 退出登录：清除 Cookie + 保存的账号密码（下次 init 不再自动续登） */
async function logoutAction() {
  await clearCookie();
  try {
    await Promise.all([
      authConfig.save("auth.username", ""),
      authConfig.save("auth.password", ""),
    ]);
  } catch {
    // 清除失败不影响 Cookie 清除
  }
  return { source: PLUGIN_ID, data: { ok: true, message: "已退出登录（Cookie 与保存的账号均已清除）" } };
}

async function checkLoginState() {
  await ensureCookie();
  const state = await detectLoginState();
  // 未登录时抛 unauthorized（copyComic 模式）：宿主会直接弹出插件的登录表单，
  // 比返回 ok:false 更省一步操作
  if (!state.loggedIn) {
    throw buildUnauthorizedError(PLUGIN_ID, state.hint || "登录已失效，请重新登录");
  }
  return { source: PLUGIN_ID, data: { ok: true, message: state.hint } };
}

/** 手动刷新域名：抓官方发布页并探测可用域名 */
async function refreshDomain() {
  const before = getOrigin();
  const result = await refreshOrigin();
  const message = result.changed
    ? `域名已更新：${before} → ${result.origin}`
    : `域名未变化：${result.origin}`;
  return { source: PLUGIN_ID, message, data: { ok: true, origin: result.origin, changed: result.changed, message } };
}

/** 重置为内置默认域名 */
async function resetDomain() {
  const origin = await resetOriginToDefault();
  const message = `已重置为默认域名：${origin}`;
  return { source: PLUGIN_ID, message, data: { ok: true, origin, message } };
}

async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "capabilities",
      actions: [
        { key: "domain-refresh", title: "刷新域名（从发布页获取最新）", fnPath: "refreshDomain" },
        { key: "domain-reset", title: "重置为内置默认域名", fnPath: "resetDomain" },
        { key: "cookie-login", title: "用 Cookie 登录（账号登录失败时的备用方式）", fnPath: "getCookieLoginBundle" },
        { key: "web-login", title: "网页登录（账号登录失败时，在应用内打开网页登录）", fnPath: "startWebLogin" },
        { key: "check", title: "检查登录状态", fnPath: "checkLoginState" },
        { key: "clear", title: "清除登录 Cookie", fnPath: "clearCookieAction" },
        { key: "logout", title: "退出登录（同时清除保存的账号）", fnPath: "logoutAction" },
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
  getUserInfoBundle,
  getLoginBundle,
  getCookieLoginBundle,
  loginWithAccount,
  loginWithCookie,
  clearCookieAction,
  logoutAction,
  startWebLogin,
  saveWebLoginCookie,
  checkLoginState,
  refreshDomain,
  resetDomain,
  getCapabilitiesBundle,
};
