import type { ComicListScene, InfoContract, PluginFunctionItem } from "breeze-plugin-kit";
import { PLUGIN_ID, PLACEHOLDER_IMAGE_URL } from "./common";
import { DEFAULT_ORIGIN } from "./origin";

/** 发布仓库；Breeze 只会扫描 GitHub 上以 Breeze-plugin- 开头的仓库 */
const GITHUB_OWNER = "k623615746";
const GITHUB_REPO = "Breeze-plugin-zerobyw";

/** 自动更新通道：GitHub Release API（客户端仅对此域名套用镜像加速） */
const UPDATE_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

const ICON_URL = "https://cdn.jsdelivr.net/gh/k623615746/Breeze-plugin-zerobyw@main/assets/icon.png";

function buildScene(title: string, core: Record<string, unknown> = {}): ComicListScene {
  return {
    title,
    source: PLUGIN_ID,
    body: {
      type: "pluginPagedComicList",
      request: {
        fnPath: "getRankingData",
        core,
        extern: {},
      },
    },
    filter: {
      fnPath: "getRankingFilterBundle",
      core,
      extern: {},
    },
  };
}

function buildFunctions(): PluginFunctionItem[] {
  return [
    {
      id: "all",
      title: "全部漫画",
      action: {
        type: "openComicList",
        payload: { scene: buildScene("全部漫画") },
      },
    },
    {
      id: "popular",
      title: "人气排行",
      action: {
        type: "openComicList",
        payload: {
          scene: buildScene("人气排行", { order: "views", dir: "desc" }),
        },
      },
    },
    {
      id: "latest",
      title: "最新上架",
      action: {
        type: "openComicList",
        payload: {
          scene: buildScene("最新上架", { order: "addtime", dir: "desc" }),
        },
      },
    },
  ];
}

/** 插件注册信息（宿主发现页卡片 / 更新通道） */
export function buildPluginInfo(): InfoContract {
  return {
    name: "zero搬运网",
    uuid: PLUGIN_ID,
    iconUrl: ICON_URL || PLACEHOLDER_IMAGE_URL,
    describe: [
      "zero搬运网（zerobyw33）漫画源。",
      "",
      "- 支持关键词搜索、分类筛选、人气/最新排行",
      "- 章节列表取自阅读页目录，完整话数可见",
      "- 域名失效时自动从官方发布页获取最新域名",
      "- 部分章节需要站点账号登录；在插件设置里用账号密码直接登录",
      "",
      "> 内容版权归原作者及出版方所有，本插件仅做页面解析，不存储、不分发任何漫画内容。",
    ].join("\n"),
    version: "1.4.0",
    home: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
    updateUrl: UPDATE_URL,
    function: buildFunctions(),
  };
}

/** 生成 manifest.json（发布/安装用） */
export function buildManifestInfo() {
  const info = buildPluginInfo();
  return {
    name: info.name,
    uuid: info.uuid,
    iconUrl: info.iconUrl,
    describe: info.describe,
    version: info.version,
    home: info.home,
    updateUrl: info.updateUrl,
    function: info.function,
  };
}


