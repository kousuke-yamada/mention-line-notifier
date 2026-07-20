import crypto from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright";

const COMMUNITY_URL =
  process.env.COMMUNITY_URL ??
  "https://community-app.the-online-class.com/?enterprise_id=oQMgoTZ&tab=mention";
const STATE_FILE = "state.json";
const DEBUG_DIR = "debug";
// メンション一覧の1件分を指すセレクタ。data-testid はレイアウト変更やスタイルの
// 変更に影響されないため、クラス名ではなくこちらを使う。
// 未設定・空文字の場合はデフォルトを使う(?? は空文字を弾かないため trim()||)
const MENTION_ITEM_SELECTOR =
  process.env.MENTION_ITEM_SELECTOR?.trim() ||
  "[data-testid^='mention-list-item-']";
const MENTION_LIST_SELECTOR = "[data-testid='mention-list']";
const MAX_SEEN = 300;
// CI は実機より遅く、スケジュール実行は数時間空くことがある(GitHub 側の間引き)。
// 1回の失敗で次の実行まで通知が止まるため、その場でリトライして復旧させる。
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS) || 90000;
const LOGIN_ATTEMPTS = Number(process.env.LOGIN_ATTEMPTS) || 3;
// 失敗通知が毎回飛ぶと LINE の無料枠(月200通)を食い潰すため間隔を空ける
const FAILURE_NOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;

const required = ["SITE_EMAIL", "SITE_PASSWORD"];
if (!process.env.DISCOVER) {
  required.push("LINE_CHANNEL_ACCESS_TOKEN", "LINE_USER_ID");
}
for (const key of required) {
  if (!process.env[key]) {
    console.error(`環境変数 ${key} が設定されていません`);
    process.exit(1);
  }
}

const hash = (s) =>
  crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { initialized: false, seen: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function pushLine(text) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: process.env.LINE_USER_ID,
      messages: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    throw new Error(`LINE push 失敗: ${res.status} ${await res.text()}`);
  }
}

async function dumpDebug(page, label) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  await page.screenshot({ path: `${DEBUG_DIR}/${label}.png`, fullPage: true });
  fs.writeFileSync(`${DEBUG_DIR}/${label}.html`, await page.content());
  console.log(`デバッグ情報を ${DEBUG_DIR}/${label}.{png,html} に保存しました`);
}

// 1回分のログイン試行。成功したら true、フォームが消えなければ false。
async function attemptLogin(page) {
  await page.goto(COMMUNITY_URL, { waitUntil: "networkidle" });
  const passwordInput = page.locator("input[type='password']");
  if ((await passwordInput.count()) === 0) return true; // 既にログイン済み

  const emailInput = page
    .locator("input[name='email'], input[type='email']")
    .first();
  await emailInput.fill(process.env.SITE_EMAIL);
  await passwordInput.first().fill(process.env.SITE_PASSWORD);
  await page
    .locator("button:has-text('ログイン'), button[type='submit']")
    .first()
    .click();

  // SPA のため画面遷移を待たず、ログインフォーム(パスワード欄)が消えるまで待つ
  try {
    await passwordInput
      .first()
      .waitFor({ state: "detached", timeout: LOGIN_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function login(page) {
  console.log("ログインします...");
  for (let i = 1; i <= LOGIN_ATTEMPTS; i++) {
    if (await attemptLogin(page)) {
      console.log(`ログイン成功(試行 ${i}/${LOGIN_ATTEMPTS})`);
      await page.waitForLoadState("networkidle");
      return;
    }
    console.log(`ログイン試行 ${i}/${LOGIN_ATTEMPTS} 失敗`);
    if (i < LOGIN_ATTEMPTS) await page.waitForTimeout(5000);
  }

  // 全試行が失敗。エラーメッセージが出ていないか確認して終了する
  const bodyText = await page.locator("body").innerText();
  const errorHint = /認証|パスワード|正しく|失敗|エラー|reCAPTCHA/i.exec(bodyText);
  await dumpDebug(page, "login-failed");
  throw new Error(
    `ログインに失敗しました(${LOGIN_ATTEMPTS}回試行、フォームが消えませんでした)。` +
      (errorHint
        ? `画面のヒント: 「${errorHint[0]}」付近を確認`
        : "reCAPTCHA の可能性あり")
  );
}

// ログイン後はデフォルトチャンネルへリダイレクトされるため、
// メンションタブの URL へ明示的に遷移し直す。
async function openMentions(page) {
  if (!page.url().includes("tab=mention")) {
    await page.goto(COMMUNITY_URL, { waitUntil: "networkidle" });
  }
  await page
    .locator(MENTION_LIST_SELECTOR)
    .waitFor({ state: "attached", timeout: 30000 });
  await page.waitForTimeout(2000); // 一覧の描画待ち
}

async function collectMentions(page) {
  const items = await page.locator(MENTION_ITEM_SELECTOR).all();
  const mentions = [];
  for (const item of items) {
    const text = (await item.innerText()).replace(/\s+/g, " ").trim();
    if (text.length < 5) continue;
    // data-testid の接尾辞はサーバー側のメンションIDなので、
    // 本文や相対時刻表示が変わっても同一メンションを追跡できる。
    const testId = await item.getAttribute("data-testid");
    const serverId = testId?.replace(/^mention-list-item-/, "");
    mentions.push({ id: serverId || hash(text), text });
  }
  return mentions;
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "ja-JP",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  try {
    await login(page);
    await openMentions(page);

    if (process.env.DISCOVER) {
      // セレクタ調整用: 通知は送らず、メンション画面の内容を保存して終了
      await dumpDebug(page, "mentions-page");
      const mentions = await collectMentions(page);
      console.log(`現在のセレクタで ${mentions.length} 件検出:`);
      for (const m of mentions) console.log(`- [${m.id}] ${m.text.slice(0, 80)}`);
      return;
    }

    const mentions = await collectMentions(page);
    console.log(`メンション ${mentions.length} 件を取得`);
    if (mentions.length === 0) {
      await dumpDebug(page, "no-mentions");
      throw new Error(
        "メンションを1件も検出できませんでした。セレクタずれの可能性があるため異常終了します"
      );
    }

    const state = loadState();
    const seen = new Set(state.seen);
    const newMentions = mentions.filter((m) => !seen.has(m.id));

    if (!state.initialized) {
      console.log("初回実行のため通知せず、現在のメンションを記録のみします");
    } else if (newMentions.length > 0) {
      console.log(`新着メンション ${newMentions.length} 件を通知します`);
      const lines = newMentions
        .slice(0, 5)
        .map((m) => `・${m.text.slice(0, 100)}`);
      if (newMentions.length > 5) lines.push(`…ほか ${newMentions.length - 5} 件`);
      await pushLine(
        `【新着メンション ${newMentions.length}件】\n${lines.join("\n")}\n${COMMUNITY_URL}`
      );
    } else {
      console.log("新着メンションはありません");
    }

    saveState({
      initialized: true,
      seen: [...newMentions.map((m) => m.id), ...state.seen].slice(0, MAX_SEEN),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    try {
      await dumpDebug(page, "error");
    } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}

// 失敗しても気づけないとサイレントに通知が止まるため LINE で知らせる。
// ただし毎回送ると無料枠を食うので、前回通知から一定時間空いた場合のみ送る。
async function notifyFailure(err) {
  if (process.env.DISCOVER) return;
  const state = loadState();
  const last = state.failureNotifiedAt
    ? Date.parse(state.failureNotifiedAt)
    : 0;
  if (Date.now() - last < FAILURE_NOTIFY_INTERVAL_MS) {
    console.log("失敗通知は抑制されました(前回通知から間隔が短いため)");
    return;
  }
  try {
    await pushLine(
      `【メンション監視エラー】\n${String(err?.message ?? err).slice(0, 200)}\n` +
        `GitHub Actions のログを確認してください`
    );
    // 通知済み時刻を記録(成功時は saveState が上書きしてクリアされる)
    saveState({ ...state, failureNotifiedAt: new Date().toISOString() });
  } catch (e) {
    console.error("失敗通知の送信にも失敗しました:", e.message);
  }
}

main().catch(async (err) => {
  console.error(err);
  await notifyFailure(err);
  process.exit(1);
});
