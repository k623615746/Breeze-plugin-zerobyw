/**
 * 账号密码登录
 *
 * 站点是 Discuz! 架构：登录页会下发一次性 formhash + loginhash，
 * POST 到 member.php?mod=logging&action=login&loginsubmit=yes 才能通过。
 * 登录成功后服务端通过 Set-Cookie 下发认证 cookie（前缀形如 W6vj_2132_，
 * 每个站点实例可能不同，所以整包按名字存取，不假设固定前缀）。
 */
import { authConfig } from "breeze-plugin-kit";
import { cleanText } from "./common";
import { getOrigin, setOrigin } from "./origin";
import { fetchSitePath, getSessionCookie, postSiteForm, saveCookie } from "./http";
import { persistCurrentOrigin } from "./site";

const LOGIN_PAGE = "/member.php?mod=logging&action=login";

/** 保存的账号密码配置键（学习 copyComic：登录成功后留存，供 init 时自动续登） */
const AUTH_USERNAME_KEY = "auth.username";
const AUTH_PASSWORD_KEY = "auth.password";

export type LoginForm = {
  formhash: string;
  loginhash: string;
};

export type LoginResult = {
  ok: boolean;
  message: string;
  /** 登录后 cookie 里的认证项数量，便于排查 */
  cookieCount: number;
};

/** 读取保存的账号密码（供 init 自动续登与登录表单回填） */
export async function getSavedAccount(): Promise<{ username: string; password: string }> {
  try {
    const [username, password] = await Promise.all([
      authConfig.load(AUTH_USERNAME_KEY, ""),
      authConfig.load(AUTH_PASSWORD_KEY, ""),
    ]);
    return {
      username: String(username ?? "").trim(),
      password: typeof password === "string" ? password : "",
    };
  } catch {
    return { username: "", password: "" };
  }
}

/** 抓取登录页，提取这次会话的 formhash 与 loginhash */
export async function fetchLoginForm(): Promise<LoginForm> {
  const html = await fetchSitePath(LOGIN_PAGE);

  const formhash =
    html.match(/name="formhash"\s+value="([0-9a-zA-Z]+)"/)?.[1] ??
    html.match(/formhash=([0-9a-zA-Z]+)/)?.[1] ??
    "";
  const loginhash =
    html.match(/loginhash=([0-9a-zA-Z]+)/)?.[1] ??
    html.match(/loginform_([0-9a-zA-Z]+)"/)?.[1] ??
    "";

  if (!formhash || !loginhash) {
    throw new Error("未能从登录页解析出 formhash / loginhash，站点结构可能已调整");
  }
  return { formhash, loginhash };
}

/** 从响应 HTML 里抽取错误提示 */
function extractErrorMessage(html: string): string {
  // Discuz 登录失败页的真实结构是
  // <div id="messagetext" class="alert_error"><p>登录失败，您还可以尝试 4 次</p>
  // 以及 returnmessage 弹层。按覆盖面从精确到宽松依次匹配。
  const candidates = [
    // <p> 直接包错误文案（alert_error / alert_info 均可，class 可能在 id 之后）
    /<(?:div|p)[^>]*class="alert_(?:error|info)"[^>]*>\s*<p[^>]*>\s*([^<]{1,120})<\/p>/,
    /<div[^>]*class="alert_error"[^>]*>[\s\S]{0,300}?<p[^>]*>([^<]{1,120})<\/p>/,
    /<div[^>]*class="alert_info"[^>]*>[\s\S]{0,300}?<p[^>]*>([^<]{1,120})<\/p>/,
    // returnmessage 弹层
    /id="returnmessage_[^"]*"[^>]*>\s*([^<]{1,120})</,
    // 兜底：任何 alert_* 容器里的 <p>
    /class="alert_(?:error|info)"[^>]*>[\s\S]{0,400}?<p[^>]*>\s*([^<]{1,120})<\/p>/,
  ];
  for (const pattern of candidates) {
    const matched = html.match(pattern);
    const text = cleanText(matched?.[1]);
    if (text) {
      return text;
    }
  }
  return "";
}

/**
 * 判定登录成功的信号。
 * 最可靠的是服务端下发的认证 cookie（形如 <prefix>_auth=...）；
 * 其次是页面里的成功提示。两者都不满足才判失败。
 */
function looksLoggedIn(html: string, cookie: string): boolean {
  const hasAuthCookie = /(?:^|;\s*)[^;]*_auth=/i.test(cookie);
  if (hasAuthCookie) {
    return true;
  }
  return (
    /欢迎您回来|欢迎回来/.test(html) ||
    /succeedhandle_login|succeedhandle/.test(html) ||
    /登录成功/.test(html) ||
    /discuz_uid\s*=\s*'(?!0')/.test(html)
  );
}

/**
 * 用账号密码登录。
 * questionid/answer 是 Discuz 的「安全提问」，账号没设置时留空即可。
 */
export async function loginWithAccount(input: {
  username: string;
  password: string;
  questionid?: string;
  answer?: string;
}): Promise<LoginResult> {
  const username = cleanText(input.username);
  const password = typeof input.password === "string" ? input.password : "";

  if (!username || !password) {
    throw new Error("账号和密码都不能为空");
  }

  const { formhash, loginhash } = await fetchLoginForm();
  console.log("[zerobyw] 登录表单:", formhash, loginhash);

  const questionid = cleanText(input.questionid) || "0";
  const answer = cleanText(input.answer);

  const action =
    `/member.php?mod=logging&action=login&loginsubmit=yes` +
    `&formhash=${encodeURIComponent(formhash)}&loginhash=${encodeURIComponent(loginhash)}`;

  // 503 处理链：等 1.5s 重试一次 → 仍 503 则降级 http 重试（避开针对 TLS 指纹的 WAF 拦截）
  const postBody = {
    referer: "/",
    loginfield: "username",
    username,
    password,
    questionid,
    answer,
    cookietime: "2592000",
    formhash,
  };

  let res = await postSiteForm(action, postBody);

  if (res.status === 503) {
    console.log("[zerobyw] 登录收到 503，1.5 秒后重试一次");
    await sleep(1500);
    res = await postSiteForm(action, postBody);
  }

  if (res.status === 503) {
    const httpOrigin = getOrigin().replace(/^https:/i, "http:");
    if (httpOrigin !== getOrigin()) {
      console.log("[zerobyw] https 登录仍被拦（503），降级 http 重试:", httpOrigin);
      setOrigin(httpOrigin);
      await persistCurrentOrigin();
      res = await postSiteForm(action, postBody);
    }
  }

  if (res.status >= 400) {
    if (res.status === 503) {
      throw new Error(
        "登录请求被站点拦截（HTTP 503）。多为站点对自动化登录的临时风控，可稍等几分钟再试；" +
          "若持续失败，请改用「Cookie 登录」：在浏览器登录一次后粘贴 Cookie 导入。",
      );
    }
    throw new Error(`登录请求失败（HTTP ${res.status}）`);
  }

  if (!looksLoggedIn(res.text, getSessionCookie())) {
    const detail = extractErrorMessage(res.text);
    // 提取「还可以尝试 N 次」这类限流提示，帮助判断是账号问题还是被风控
    const retry = res.text.match(/还可以尝试\s*(\d+)\s*次/)?.[1];
    const webLoginGuide = "；也可在插件设置里点「网页登录」，在应用内用浏览器完成登录";
    const hint = /验证码|seccode/i.test(res.text)
      ? `站点要求输入验证码${webLoginGuide}`
      : retry
        ? `登录失败（${detail || "账号或密码不正确"}）；该账号/IP 已被限流，剩余尝试 ${retry} 次${webLoginGuide}`
        : "";
    throw new Error(`${detail || hint || "登录失败，请检查账号密码是否正确"}${webLoginGuide}`);
  }

  // 认证 cookie 已由 postSiteForm 吸收，这里持久化
  const saved = await saveCookieFromSession();
  // 同时留存账号密码，供 App 重启（init）时自动续登——cookie 过期后无需手动再登一次
  try {
    await Promise.all([
      authConfig.save(AUTH_USERNAME_KEY, username),
      authConfig.save(AUTH_PASSWORD_KEY, password),
    ]);
  } catch {
    // 保存失败不影响本次登录成功
  }
  return {
    ok: true,
    message: "登录成功",
    cookieCount: saved,
  };
}

/**
 * 用保存的账号密码自动登录（init 自动续登用）。
 * 最多 3 次重试（学习 copyComic 的 loginForInit）；没有保存账号则直接跳过。
 */
export async function loginWithSavedAccount(): Promise<LoginResult | null> {
  const { username, password } = await getSavedAccount();
  if (!username || !password) {
    console.info("[zerobyw] 无保存的账号，跳过自动登录");
    return null;
  }
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await loginWithAccount({ username, password });
      console.info(`[zerobyw] 自动登录成功（第 ${attempt} 次尝试）`);
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`[zerobyw] 自动登录失败（第 ${attempt}/3 次）`, error);
      // 账号被限流时等 5 秒再试
      await sleep(5000);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`自动登录失败，已重试 3 次: ${String(lastError)}`);
}

/** 把当前会话 cookie 落盘，返回 cookie 项数 */
async function saveCookieFromSession(): Promise<number> {
  const cookie = getSessionCookie();
  await saveCookie(cookie);
  if (!cookie) {
    return 0;
  }
  return cookie.split(";").filter((part) => part.includes("=")).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
