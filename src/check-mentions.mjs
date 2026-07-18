import crypto from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright";

const COMMUNITY_URL =
  process.env.COMMUNITY_URL ??
  "https://app.the-online-class.com/community/enterprise/oQMgoTZ";
const STATE_FILE = "state.json";
const DEBUG_DIR = "debug";
// メンション一覧の1件分を指すセレクタ。CSSモジュールのハッシュは再デプロイで
// 変わりうるため、クラス名の前方一致で指定してハッシュ依存を避ける。
// 未設定・空文字の場合はデフォルトを使う(?? は空文字を弾かないため trim()||)
const MENTION_ITEM_SELECTOR =
  process.env.MENTION_ITEM_SELECTOR?.trim() ||
  "[class*='_activity_list_container_'] > [class*='_hover_container_']";
const MAX_SEEN = 300;

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

async function login(page) {
  await page.goto(COMMUNITY_URL, { waitUntil: "networkidle" });
  const passwordInput = page.locator("input[type='password']");
  if ((await passwordInput.count()) === 0) return; // 既にログイン済み

  console.log("ログインページを検出。ログインします...");
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
    await passwordInput.first().waitFor({ state: "detached", timeout: 45000 });
  } catch {
    // まだ残っている場合、エラーメッセージが出ていないか確認
    const bodyText = await page.locator("body").innerText();
    const errorHint = /認証|パスワード|正しく|失敗|エラー|reCAPTCHA/i.exec(
      bodyText
    );
    await dumpDebug(page, "login-failed");
    throw new Error(
      "ログインに失敗しました(フォームが消えませんでした)。" +
        (errorHint ? `画面のヒント: 「${errorHint[0]}」付近を確認` : "reCAPTCHA の可能性あり")
    );
  }

  console.log("ログイン成功");
  await page.waitForLoadState("networkidle");
  if (!page.url().startsWith(COMMUNITY_URL)) {
    await page.goto(COMMUNITY_URL, { waitUntil: "networkidle" });
  }
}

async function openMentions(page) {
  const menu = page.getByText("メンション", { exact: true }).first();
  await menu.waitFor({ timeout: 15000 });
  await menu.click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000); // 一覧の描画待ち
}

// 相対時刻表示(今日/昨日 HH:MM、YYYY/M/D HH:MM)は時間経過で変化するため、
// ID 算出前に除去する。これをしないと同じメンションが再通知されてしまう。
function stableKey(text) {
  return text
    .replace(/(今日|昨日)\s*\d{1,2}:\d{2}/g, "")
    .replace(/\d{4}\/\d{1,2}\/\d{1,2}\s*\d{1,2}:\d{2}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function collectMentions(page) {
  const items = await page.locator(MENTION_ITEM_SELECTOR).all();
  const mentions = [];
  for (const item of items) {
    const text = (await item.innerText()).replace(/\s+/g, " ").trim();
    if (text.length < 5) continue;
    mentions.push({ id: hash(stableKey(text)), text });
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
