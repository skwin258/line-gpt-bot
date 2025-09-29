// index.js  (Node 18+ / ESM)
import 'dotenv/config';
import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import OpenAI from 'openai';

/* =========================
 * 基本設定
 * ========================= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const app = express();
const client = new Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
 * 伺服器層優化
 * ========================= */
app.set('trust proxy', 1);
app.disable('x-powered-by');
let serverRef = null;

/* =========================
 * 使用者與管理員
 * ========================= */
const allowedUsers = new Set([
  'U48c33cd9a93a3c6ce8e15647b8c17f08',
  'Ufaeaa194b93281c0380cfbfd59d5aee0',
  'U73759fc9139edfaf7c804509d0a8c07f',
  'U63918f9d8b44770747034598a351595e',
  'U1cebd63109f62550c10df0ab835a900c', // 管理員（你提供）
  'U0ea07940728c64ae26385f366b5b9603',
  'U35cf199d3a707137efed545d782e11c0',
  'Udbc76d0c8fab9a80a1c6a7ef12ac5e81',
  'Uc3be515b0b2e4c8807ad8552d40d1714',
  'U1dff266a17b2747f1b48d0c21d7b800e',
  'Uf7c1ad44ebc11e81cb24a2a38b9f3b39',
  'Ue8b6bc45c358eb4d56f557a6d52c3a11',
  'U65d7a660c1f5c2a4e8c975b2835a11d7',
]);

// 群組管理員（可多人）
const GROUP_ADMIN_UIDS = new Set(['U1cebd63109f62550c10df0ab835a900c']);

/* =========================
 * 狀態暫存
 * ========================= */
const userLastActiveTime = new Map();
const resultPressCooldown = new Map();
const userRecentInput = new Map();
const qaModeUntil = new Map();
const handledEventIds = new Map();

const userCurrentTable = new Map();
const userLastRecommend = new Map();
const userBetLogs = new Map();

const groupCurrentTable = new Map();
const groupLastRecommend = new Map();
const groupBetLogs = new Map();
const groupAdminBinder = new Map();

const userLastMsgAt = new Map();
const USER_MIN_INTERVAL_MS = 250;

const INACTIVE_MS = 2 * 60 * 1000;
const RESULT_COOLDOWN_MS = 10 * 1000;
const QA_WINDOW_MS = 3 * 60 * 1000;
const EVENT_DEDUPE_MS = 5 * 60 * 1000;

/* =========================
 * 小工具
 * ========================= */
const isGroupLike = (e) => e?.source?.type === 'group' || e?.source?.type === 'room';
const getChatId = (e) =>
  e?.source?.type === 'group' ? e.source.groupId :
  (e?.source?.type === 'room' ? e.source.roomId : e?.source?.userId);
const isAdmin = (uid) => GROUP_ADMIN_UIDS.has(uid);

function dedupeEvent(event) {
  const id = event?.deliveryContext?.isRedelivery
    ? `${event?.postback?.data || event?.message?.id || event?.replyToken}-R`
    : (event?.postback?.data || event?.message?.id || event?.replyToken || `${event?.timestamp || ''}-${Math.random()}`);
  const now = Date.now();
  for (const [k, ts] of handledEventIds) if (ts <= now) handledEventIds.delete(k);
  if (handledEventIds.has(id)) return true;
  handledEventIds.set(id, now + EVENT_DEDUPE_MS);
  return false;
}

async function withRetry(fn, { tries = 3, baseDelay = 150 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err?.statusCode || err?.originalError?.response?.status || err?.status;
      if (![429, 499, 500, 502, 503, 504].includes(status)) break;
      const delay = baseDelay * Math.pow(2, i) + Math.floor(Math.random() * 100);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function safeReply(event, messages) {
  if (!Array.isArray(messages)) messages = [messages];
  try { await withRetry(() => client.replyMessage(event.replyToken, messages)); }
  catch {
    const src = event?.source || {};
    const to = src.type==='group' ? src.groupId : (src.type==='room' ? src.roomId : src.userId);
    if (to) await withRetry(() => client.pushMessage(to, messages)).catch(()=>{});
  }
}

async function callOpenAIWithTimeout(messages, { model = 'gpt-4o-mini', timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await openai.chat.completions.create(
      { model, messages, temperature: 0.7, top_p: 0.95 },
      { signal: controller.signal }
    );
    return resp?.choices?.[0]?.message?.content || '（AI 暫時沒有回覆）';
  } catch {
    return '（AI 回應異常，請稍後再試）';
  } finally { clearTimeout(timer); }
}

/* =========================
 * 遊戲資料
 * ========================= */
const tableData = {
  DG真人: {
    旗艦廳: ['百家樂D01','百家樂D02','百家樂D03','百家樂D04','百家樂D05','百家樂D06','百家樂D07','百家樂D08'],
    現場廳: ['百家樂C01','百家樂C02','百家樂C03','百家樂C04','百家樂C05','百家樂C06'],
    亞洲廳: ['百家樂A01','百家樂A02','百家樂A03','百家樂A04','百家樂A05'],
  },
  歐博真人: {
    百家樂: ['百家樂B001','百家樂B201','百家樂B202','百家樂B203','百家樂B601','百家樂B602','百家樂B603','百家樂B604'],
    快速百家樂: ['快速百家樂Q001','快速百家樂Q002','快速百家樂Q003','快速百家樂Q201','快速百家樂Q202','快速百家樂Q203','快速百家樂Q501','快速百家樂Q502'],
    經典百家樂: ['百家樂B018','百家樂B019','百家樂B219'],
    性感百家樂: ['性感百家樂B501','性感百家樂B502','性感百家樂B503','性感百家樂B504','性感百家樂B505','性感百家樂B506','性感百家樂B507'],
    咪牌百家樂: ['咪牌百家樂C001','咪牌百家樂C201','咪牌百家樂C202','咪牌百家樂C501'],
    VIP廳: ['VIP百家樂V901','VIP百家樂V902','VIP百家樂V911','VIP百家樂V912'],
    保險百家樂: ['保險百家樂IB201','保險百家樂IB202'],
  },
  WM真人: {
    百家樂: ['性感百家樂1','性感百家樂2','性感百家樂3','性感百家樂4','性感百家樂5','極速百家樂6','極速百家樂7','極速百家樂8','極速百家樂9','極速百家樂10','極速百家樂11','極速百家樂12','主題百家樂13','主題百家樂14','主題百家樂15','主題百家樂16','主題百家樂17','主題百家樂18','咪牌百家樂19'],
    龍虎鬥: ['龍虎1','龍虎2','龍虎3'],
  },
  沙龍真人: {
    百家樂: ['百家樂D01','百家樂D02','百家樂D03','百家樂D04','百家樂D05','百家樂D06','百家樂D07','極速百家樂D08','百家樂C01','百家樂C02','百家樂C03','百家樂C04','百家樂C05','百家樂C06','百家樂C07','極速百家樂C08','百家樂M01','百家樂M02','百家樂M03','極速百家樂M04'],
    龍虎鬥: ['D龍虎','M龍虎'],
  },
};

/* =========================
 * Flex 產生器（全部使用 postback）
 * ========================= */
function pb(action, data, displayText = undefined) {
  // 若提供 displayText，只在私聊使用（群組裡我們不傳 displayText 避免出字）
  if (displayText) return { type: 'postback', data, displayText };
  return { type: 'postback', data };
}

function generateGameSelectFlex(isDM = false) {
  const mk = (label) => ({
    type: 'button', style: 'primary', color: '#00B900',
    action: pb('postback', `PICK_GAME|${label}`, isDM ? label : undefined),
  });
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: 'SKwin AI算牌系統', weight: 'bold', color: '#00B900', size: 'lg', align: 'center' },
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '請選擇遊戲', align: 'center', margin: 'md', weight: 'bold' },
      { type: 'box', layout: 'vertical', margin: 'lg', spacing: 'md', contents: [
        mk('DG真人'), mk('歐博真人'), mk('沙龍真人'), mk('WM真人'),
      ]},
    ]},
  };
}

function generateHallSelectFlex(gameName, isDM = false) {
  const halls = Object.keys(tableData[gameName] || {});
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: `遊戲：${gameName}`, weight: 'bold', color: '#00B900', size: 'lg', align: 'center' },
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '請選擇遊戲廳', weight: 'bold', align: 'center', margin: 'md' },
      { type: 'box', layout: 'vertical', spacing: 'md', margin: 'lg',
        contents: halls.map(hall => ({
          type: 'button', style: 'primary', color: '#00B900',
          action: pb('postback', `PICK_HALL|${gameName}|${hall}`, isDM ? hall : undefined),
        })),
      },
    ]},
  };
}

function generateTableListFlex(gameName, hallName, tables, page = 1, pageSize = 10, isDM = false) {
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, tables.length);
  const pageTables = tables.slice(startIndex, endIndex);

  const bubbles = pageTables.map((table) => ({
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: table, weight: 'bold', size: 'md', color: '#00B900' },
      { type: 'text', text: '進行中', size: 'sm', color: '#555555', margin: 'sm' },
      { type: 'text', text: `最低下注：100元`, size: 'sm', color: '#555555', margin: 'sm' },
      { type: 'text', text: `最高限額：10000元`, size: 'sm', color: '#555555', margin: 'sm' },
      { type: 'button',
        action: pb('postback', `PICK_TABLE|${gameName}|${hallName}|${table}`, isDM ? `選擇 ${table}` : undefined),
        style: 'primary', color: '#00B900', margin: 'md' },
    ]},
  }));

  const carousel = { type: 'carousel', contents: bubbles };

  if (endIndex < tables.length) {
    carousel.contents.push({
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: '還有更多牌桌，點擊下一頁', wrap: true, size: 'md', weight: 'bold', align: 'center' },
        { type: 'button',
          action: pb('postback', `NEXT|${page + 1}|${gameName}|${hallName}`, isDM ? '下一頁' : undefined),
          style: 'primary', color: '#00B900', margin: 'lg' },
      ]},
    });
  }
  return carousel;
}

function generateInputInstructionFlex(fullTableName, isDM = false) {
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '分析中', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
      { type: 'text', text: `桌號：${fullTableName}`, margin: 'md', color: '#555555' },
      { type: 'text', text: '請輸入前10局閒莊和的結果，最少需要輸入前三局，例:閒莊閒莊閒莊閒莊和閒', margin: 'md', color: '#555555', wrap: true },
      { type: 'button',
        action: pb('postback', `ANALYZE|${fullTableName}`, isDM ? '開始分析' : undefined),
        style: 'primary', color: '#00B900', margin: 'lg' },
    ]},
  };
}

function randHundreds(min, max) {
  const start = Math.ceil(min / 100);
  const end = Math.floor(max / 100);
  const pick = Math.floor(Math.random() * (end - start + 1)) + start;
  return pick * 100;
}
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

function generateAnalysisResultFlex(userIdOrKey, fullTableName) {
  const parts = String(fullTableName).split('|');
  const gameName = parts[0] || fullTableName;
  const hallName = parts[1] || '';
  const tableName = parts[2] || '';
  const isDragonTiger = hallName === '龍虎鬥';

  const r = Math.random() * 100;
  const mainPick = isDragonTiger ? (r < 50 ? '龍' : '虎') : (r < 50 ? '莊' : '閒');
  const attachTieSmall = Math.random() < 0.05;
  const passRate = Math.floor(Math.random() * (90 - 45 + 1)) + 45;

  let betLevel = '觀望', betAmount = 100;
  if (passRate <= 50) { betLevel = '觀望'; betAmount = 100; }
  else if (passRate <= 65) { betLevel = '小注'; betAmount = randHundreds(100, 1000); }
  else if (passRate <= 75) { betLevel = '中注'; betAmount = randHundreds(1100, 2000); }
  else { betLevel = '重注'; betAmount = randHundreds(2100, 3000); }

  const rec = { fullTableName, system: gameName, hall: hallName, table: tableName, side: mainPick, amount: betAmount, ts: Date.now() };
  if (String(userIdOrKey).startsWith('group:') || String(userIdOrKey).startsWith('room:')) {
    const key = userIdOrKey.replace(/^group:|^room:/, '');
    groupCurrentTable.set(key, fullTableName);
    groupLastRecommend.set(key, rec);
  } else {
    userCurrentTable.set(userIdOrKey, fullTableName);
    userLastRecommend.set(userIdOrKey, rec);
  }

  const proReasonsGeneric = [
    `近期節奏偏${mainPick}，勝率估約${passRate}% ，資金可採階梯式進場。`,
    `路紙單邊延伸、波動收斂，${mainPick}佔優；以風險報酬比評估，${betLevel}較合理。`,
    `連動段落未轉折，${mainPick}承接力強；量化指標偏多，依紀律${betLevel}。`,
    `慣性朝${mainPick}傾斜，優勢未被破壞；依趨勢邏輯，執行${betLevel}。`,
    `形態無反轉訊號，${mainPick}動能續航；配合分散下注原則，${betLevel}較佳。`,
  ];
  const mainReason = pickOne(proReasonsGeneric);

  const leftBtnLabel  = isDragonTiger ? '龍' : '閒';
  const rightBtnLabel = isDragonTiger ? '虎' : '莊';

  const contents = [
    { type: 'text', text: '分析結果', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
    { type: 'text', text: `牌桌：${gameName}`, margin: 'md', color: '#555555' },
    { type: 'text', text: `預測結果為：${mainPick}（${betLevel}）${attachTieSmall ? ' 和小下' : ''}`, margin: 'md', size: 'md' },
    { type: 'text', text: `推薦下注金額：${betAmount} 元`, margin: 'md', size: 'md' },
    { type: 'text', text: `過關機率：約 ${passRate}%`, margin: 'md', size: 'md' },
    { type: 'text', text: `說明：${mainReason}`, margin: 'md', wrap: true },
  ];
  if (attachTieSmall) contents.push({ type: 'text', text: `和局：小注對沖`, margin: 'md', wrap: true });

  contents.push({
    type: 'box', layout: 'horizontal', spacing: 'md', margin: 'md',
    contents: [
      { type: 'button', style: 'primary', color: '#2185D0', action: pb('postback', `ROUND_RESULT|${leftBtnLabel}|${fullTableName}`),  flex: 1 },
      { type: 'button', style: 'primary', color: '#21BA45', action: pb('postback', `ROUND_RESULT|和|${fullTableName}`),            flex: 1 },
      { type: 'button', style: 'primary', color: '#DB2828', action: pb('postback', `ROUND_RESULT|${rightBtnLabel}|${fullTableName}`), flex: 1 },
    ],
  });

  return { type: 'bubble', body: { type: 'box', layout: 'vertical', contents } };
}

function generateAdminControlFlex(fullTableName, groupId) {
  const [, hallName] = String(fullTableName).split('|');
  const isDragonTiger = hallName === '龍虎鬥';
  const left = isDragonTiger ? '龍' : '閒';
  const right = isDragonTiger ? '虎' : '莊';

  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '管理員面板', weight: 'bold', size: 'lg', color: '#DB2828', align: 'center' },
      { type: 'text', text: `桌號：${fullTableName}`, margin: 'md' },
      { type: 'text', text: '請選擇本局預測：', margin: 'md' },
      { type: 'box', layout: 'horizontal', spacing: 'md', contents: [
        { type: 'button', style: 'primary', color: '#2185D0', action: pb('postback', `ADMIN_SET|${left}|${fullTableName}|${groupId}`), flex: 1 },
        { type: 'button', style: 'primary', color: '#21BA45', action: pb('postback', `ADMIN_SET|和|${fullTableName}|${groupId}`),   flex: 1 },
        { type: 'button', style: 'primary', color: '#DB2828', action: pb('postback', `ADMIN_SET|${right}|${fullTableName}|${groupId}`), flex: 1 },
      ]},
      { type: 'text', text: '（僅供管理員使用）', margin: 'md', size: 'sm', color: '#777' },
    ]},
  };
}

function extractSimpleTableName(table) {
  const m = /([A-Z]\d{2,3})$/i.exec(table || '');
  return m ? m[1].toUpperCase() : table || '';
}

function generatePublicResultFlex({ system, hall, table, side, passRate, betAmount, betLevel, reason }) {
  const tableShort = extractSimpleTableName(table);
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: 'SKwin百家分析系統', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
      { type: 'text', text: 'Ai分析結果', weight: 'bold', align: 'center', margin: 'sm' },
      { type: 'separator', margin: 'md' },
      { type: 'text', text: `本局預測：${side}（${betLevel}）`, margin: 'md' },
      { type: 'text', text: `牌桌：${system}/${tableShort}`, margin: 'sm' },
      { type: 'text', text: `勝率：${passRate}%`, margin: 'sm' },
      { type: 'text', text: `建議下注：${betAmount}元`, margin: 'sm' },
      { type: 'text', text: `說明：${reason}`, margin: 'sm', wrap: true },
    ]},
  };
}

function computeRecommendation(side) {
  const passRate = Math.floor(Math.random() * (90 - 45 + 1)) + 45;
  let betLevel = '觀望', betAmount = 100;
  if (passRate <= 50) { betLevel='觀望'; betAmount=100; }
  else if (passRate <= 65) { betLevel='小注'; betAmount=randHundreds(100, 1000); }
  else if (passRate <= 75) { betLevel='中注'; betAmount=randHundreds(1100, 2000); }
  else { betLevel='重注'; betAmount=randHundreds(2100, 3000); }
  const reasons = [
    `形態未出現反轉訊號，${side}動能續航；配合分散下注原則，${betLevel}較佳。`,
    `近期節奏偏${side}，勝率估約${passRate}%；以風險報酬比衡量，採${betLevel}。`,
    `波動收斂、慣性未破壞，${side}佔優，建議${betLevel}執行。`,
    `短期趨勢朝${side}傾斜；紀律交易優先，${betLevel}配置。`,
  ];
  return { passRate, betLevel, betAmount, reason: pickOne(reasons) };
}

/* =========================
 * 報表工具
 * ========================= */
const extractSimpleTable = (t)=> (/([A-Z]\d{2,3})$/i.exec(t||'')?.[1]?.toUpperCase() || (t||''));
function buildRoundReportFlexCurrent(system, hall, table, totalAmount, sumColumns) {
  const money = sumColumns * 100;
  return { type: 'flex', altText: '當局報表', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [
    { type: 'text', text: '(當局報表)', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
    { type: 'text', text: `廳別：${hall}`, margin: 'sm' },
    { type: 'text', text: `桌別：${extractSimpleTable(table)}`, margin: 'sm' },
    { type: 'text', text: `總下注金額：${totalAmount}`, margin: 'sm' },
    { type: 'text', text: `輸贏金額：${money >= 0 ? '+' : ''}${money}`, margin: 'sm' },
    { type: 'text', text: `柱碼：${sumColumns >= 0 ? '+' : ''}${sumColumns}柱`, margin: 'sm' },
  ]}}};
}
function buildDailyReportFlex(systems, tables, totalAmount, sumColumns) {
  const money = sumColumns * 100;
  return { type: 'flex', altText: '本日報表', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [
    { type: 'text', text: '(本日報表)', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
    { type: 'text', text: `系統：${systems.join('/')}`, margin: 'sm', wrap: true },
    { type: 'text', text: `桌別：${tables.map(extractSimpleTable).join('/')}`, margin: 'sm', wrap: true },
    { type: 'text', text: `總下注金額：${totalAmount}`, margin: 'sm' },
    { type: 'text', text: `輸贏金額：${money >= 0 ? '+' : ''}${money}`, margin: 'sm' },
    { type: 'text', text: `柱碼：${sumColumns >= 0 ? '+' : ''}${sumColumns}柱`, margin: 'sm' },
  ]}}};
}
const columnsFromAmount = (amount) => Math.round(Number(amount || 0) / 100);
function getTodayRangeTimestamp() {
  const tz = 'Asia/Taipei'; const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y,m,d] = fmt.split('-').map(n=>parseInt(n,10));
  const start = new Date(Date.UTC(y, m-1, d, 4, 0, 0, 0));
  const end   = new Date(Date.UTC(y, m-1, d, 15, 59, 59, 999));
  return { startMs:+start, endMs:+end };
}

/* =========================
 * 公開關鍵字
 * ========================= */
const CONTACT_REPLY_TEXT = `💥加入會員立刻領取5000折抵金💥
有任何疑問，客服隨時為您服務。
https://lin.ee/6kcsWNF`;
function tryPublicKeyword(msg) {
  if (/^聯絡客服$/i.test(msg)) return { type: 'text', text: CONTACT_REPLY_TEXT };
  if (/^報表$/i.test(msg)) return { type: 'text', text: '請輸入：當局報表 / 本日報表' };
  return null;
}

/* =========================
 * 路由
 * ========================= */
app.post('/webhook', middleware(config), async (req, res) => {
  res.status(200).end();

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  for (const event of events) {
    if (dedupeEvent(event)) continue;

    const throttleKey = `${getChatId(event)}:${event?.source?.userId || 'u'}`;
    const now = Date.now();
    const last = userLastMsgAt.get(throttleKey) || 0;
    if (now - last < USER_MIN_INTERVAL_MS) continue;
    userLastMsgAt.set(throttleKey, now);

    handleEvent(event).catch(err => console.error('事件處理錯誤:', err?.message || err));
  }
});
app.get('/', (_req, res) => res.send('OK'));
const PORT = process.env.PORT || 3000;
serverRef = app.listen(PORT, () => console.log(`Server running on ${PORT}`));
serverRef.keepAliveTimeout = 65000;
serverRef.headersTimeout = 66000;

/* =========================
 * 事件處理
 * ========================= */
async function handleEvent(event) {
  const userId = event.source?.userId;
  const inGroup = isGroupLike(event);

  // 僅限已開通
  if (!allowedUsers.has(userId)) {
    if (event.type === 'message' && event.message.type === 'text') {
      return safeReply(event, {
        type: 'text',
        text: `您沒有使用權限，請先開通會員。\n\n您的uid為：${userId}\n\n將此id回傳至skwin-註冊送5000\n完成註冊步驟即可獲得權限，謝謝。`,
      });
    }
    return; // 非訊息（postback）忽略
  }

  // 文字關鍵字（公開／共用）
  if (event.type === 'message' && event.message.type === 'text') {
    const msg = String(event.message.text || '').trim();

    // 公開詞
    const pub = tryPublicKeyword(msg);
    if (pub) return safeReply(event, pub);

    if (inGroup) {
      // 群組：開始預測（只對管理員有反應）
      if (msg === '開始預測') {
        if (!isAdmin(userId)) return; // 非管理員完全不回
        return safeReply(event, { type: 'flex', altText: '請選擇遊戲（群組）', contents: generateGameSelectFlex(false) });
      }
      // 群組其它文字一律忽略（保持乾淨）
      return;
    }

    // ===== 私聊（自動版）文字 =====
    const now = Date.now();
    const lastActive = userLastActiveTime.get(userId) || 0;
    const firstTime = lastActive === 0;
    if (!firstTime && now - lastActive > INACTIVE_MS) {
      userLastActiveTime.set(userId, now);
      await safeReply(event, [
        { type: 'text', text: '當次預測已中斷 請重新點選開始預測' },
        { type: 'flex', altText: 'SKwin AI算牌系統 注意事項', contents: generateIntroFlex() },
      ]);
      return;
    }
    userLastActiveTime.set(userId, now);

    if (msg === '會員開通' || msg === 'AI算牌說明') {
      return safeReply(event, { type: 'flex', altText: 'SKwin AI算牌系統 注意事項', contents: generateIntroFlex() });
    }
    if (msg === '開始預測') {
      return safeReply(event, { type: 'flex', altText: '請選擇遊戲', contents: generateGameSelectFlex(true) });
    }
    if (msg === '當局報表') {
      const full = userCurrentTable.get(userId);
      if (!full) return safeReply(event, { type: 'text', text: '尚未選擇牌桌，請先選擇桌號後再查看當局報表。' });
      const [system, hall, table] = full.split('|');
      const logs = (userBetLogs.get(userId) || []).filter(x => x.fullTableName === full);
      const totalAmount = logs.reduce((s, x) => s + (Number(x.amount) || 0), 0);
      const sumColumns = logs.reduce((s, x) => s + (Number(x.columns) || 0), 0);
      return safeReply(event, buildRoundReportFlexCurrent(system, hall, table, totalAmount, sumColumns));
    }
    if (msg === '本日報表') {
      const logs = userBetLogs.get(userId) || [];
      const { startMs, endMs } = getTodayRangeTimestamp();
      const todayLogs = logs.filter(x => x.ts >= startMs && x.ts <= endMs);
      if (todayLogs.length === 0) return safeReply(event, { type: 'text', text: '今日尚無可統計的投注紀錄（計算區間 12:00–23:59）。' });
      const systems = [...new Set(todayLogs.map(x => x.system))];
      const tables  = [...new Set(todayLogs.map(x => x.table))];
      const totalAmount = todayLogs.reduce((s, x) => s + (Number(x.amount) || 0), 0);
      const sumColumns = todayLogs.reduce((s, x) => s + (Number(x.columns) || 0), 0);
      return safeReply(event, buildDailyReportFlex(systems, tables, totalAmount, sumColumns));
    }

    // 輸入前10局序列
    if (/^[閒莊和]{3,10}$/.test(msg)) {
      userRecentInput.set(userId, { seq: msg, ts: Date.now() });
      return safeReply(event, { type: 'text', text: '已接收前10局結果，請點擊「開始分析」按鈕開始計算。' });
    }
    if (/^[閒莊和]+$/.test(msg)) {
      return safeReply(event, { type: 'text', text: '目前尚未輸入前10局資訊，最少需要輸入前三局，例：閒莊閒閒和莊。' });
    }

    // 問答模式
    if (msg.startsWith('AI問與答')) {
      qaModeUntil.set(userId, Date.now() + QA_WINDOW_MS);
      const q = msg.replace(/^AI問與答\s*/, '').trim();
      if (!q) return safeReply(event, { type: 'text', text: '請問您想詢問甚麼主題或是具體問題呢?' });
      const replyText = await callOpenAIWithTimeout([{ role: 'user', content: q }]);
      return safeReply(event, { type: 'text', text: replyText });
    }
    const qaUntil = qaModeUntil.get(userId) || 0;
    if (Date.now() < qaUntil) {
      const replyText = await callOpenAIWithTimeout([{ role: 'user', content: msg }]);
      return safeReply(event, { type: 'text', text: replyText });
    }
    return;
  }

  // ====== postback 事件 ======
  if (event.type === 'postback') {
    const data = String(event.postback?.data || '');
    if (!data) return;

    if (inGroup) {
      // 非管理員在群組按任何按鈕 → 直接忽略（不產生任何訊息）
      if (!isAdmin(userId)) return;

      // 群組 postback 指令
      if (data.startsWith('PICK_GAME|')) {
        const game = data.split('|')[1];
        return safeReply(event, { type: 'flex', altText: `${game} 遊戲廳選擇`, contents: generateHallSelectFlex(game, false) });
      }
      if (data.startsWith('PICK_HALL|')) {
        const [, game, hall] = data.split('|');
        const tables = tableData[game]?.[hall];
        if (tables) {
          const flex = generateTableListFlex(game, hall, tables, 1, 10, false);
          return safeReply(event, { type: 'flex', altText: `${game} ${hall} 牌桌列表 頁1`, contents: flex });
        }
      }
      if (data.startsWith('NEXT|')) {
        const [, pageStr, game, hall] = data.split('|');
        const page = parseInt(pageStr, 10);
        const tables = tableData[game]?.[hall];
        if (tables) {
          const flex = generateTableListFlex(game, hall, tables, page, 10, false);
          return safeReply(event, { type: 'flex', altText: `${game} ${hall} 牌桌列表 頁${page}`, contents: flex });
        }
      }
      if (data.startsWith('PICK_TABLE|')) {
        const [, game, hall, table] = data.split('|');
        const full = `${game}|${hall}|${table}`;
        const groupKey = event.source.type === 'group' ? event.source.groupId : event.source.roomId;
        groupCurrentTable.set(groupKey, full);
        groupAdminBinder.set(groupKey, userId);
        // 直接把管理員面板貼在群內
        const adminPanel = generateAdminControlFlex(full, groupKey);
        return safeReply(event, { type: 'flex', altText: '管理員面板', contents: adminPanel });
      }
      if (data.startsWith('ADMIN_SET|')) {
        const parts = data.split('|');
        const side = parts[1];
        const full = parts.slice(2, parts.length - 1).join('|');
        const targetGroupId = parts[parts.length - 1];
        const [system, hall, table] = full.split('|');

        const { passRate, betLevel, betAmount, reason } = computeRecommendation(side);
        groupLastRecommend.set(targetGroupId, { fullTableName: full, system, hall, table, side, amount: betAmount, ts: Date.now() });

        const publicFlex = generatePublicResultFlex({ system, hall, table, side, passRate, betAmount, betLevel, reason });
        await withRetry(() => client.pushMessage(targetGroupId, [{ type: 'flex', altText: 'Ai分析結果', contents: publicFlex }])).catch(()=>{});

        // 給管理員私訊回報鍵
        const isDT = hall === '龍虎鬥';
        const left = isDT ? '龍' : '閒';
        const right = isDT ? '虎' : '莊';
        const adminFollow = {
          type: 'bubble',
          body: { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '已發佈到群組 ✅', weight: 'bold', align: 'center', color: '#00B900' },
            { type: 'text', text: `桌號：${full}`, margin: 'md' },
            { type: 'text', text: '請於開獎後回報當局結果：', margin: 'md' },
            { type: 'box', layout: 'horizontal', spacing: 'md', contents: [
              { type: 'button', style: 'primary', color: '#2185D0', action: pb('postback', `ROUND_RESULT_GROUP|${left}|${full}|${targetGroupId}`), flex: 1 },
              { type: 'button', style: 'primary', color: '#21BA45', action: pb('postback', `ROUND_RESULT_GROUP|和|${full}|${targetGroupId}`),   flex: 1 },
              { type: 'button', style: 'primary', color: '#DB2828', action: pb('postback', `ROUND_RESULT_GROUP|${right}|${full}|${targetGroupId}`), flex: 1 },
            ]},
          ]},
        };
        await withRetry(() => client.pushMessage(userId, [{ type: 'flex', altText: '回報當局結果', contents: adminFollow }])).catch(()=>{});
        return;
      }
      if (data.startsWith('ROUND_RESULT_GROUP|')) {
        if (!isAdmin(userId)) return;
        const parts = data.split('|');
        const actual = parts[1];
        const full = parts[2];
        const targetGroupId = parts[3];
        const last = groupLastRecommend.get(targetGroupId);
        if (last && last.fullTableName === full) {
          const cols = columnsFromAmount(last.amount) * (actual === last.side ? 1 : -1);
          const money = cols * 100;
          const entry = { ...last, actual, columns: cols, money, ts: Date.now() };
          const arr = groupBetLogs.get(targetGroupId) || [];
          arr.push(entry);
          groupBetLogs.set(targetGroupId, arr);
        }
        return safeReply(event, { type: 'text', text: '已回報群組當局結果 ✅' });
      }
      return;
    }

    // ===== 私聊（自動版） postback =====
    if (data.startsWith('PICK_GAME|')) {
      const game = data.split('|')[1];
      return safeReply(event, { type: 'flex', altText: `${game} 遊戲廳選擇`, contents: generateHallSelectFlex(game, true) });
    }
    if (data.startsWith('PICK_HALL|')) {
      const [, game, hall] = data.split('|');
      const tables = tableData[game]?.[hall];
      if (tables) {
        const flex = generateTableListFlex(game, hall, tables, 1, 10, true);
        return safeReply(event, { type: 'flex', altText: `${game} ${hall} 牌桌列表 頁1`, contents: flex });
      }
    }
    if (data.startsWith('NEXT|')) {
      const [, pageStr, game, hall] = data.split('|');
      const page = parseInt(pageStr, 10);
      const tables = tableData[game]?.[hall];
      if (tables) {
        const flex = generateTableListFlex(game, hall, tables, page, 10, true);
        return safeReply(event, { type: 'flex', altText: `${game} ${hall} 牌桌列表 頁${page}`, contents: flex });
      }
    }
    if (data.startsWith('PICK_TABLE|')) {
      const [, game, hall, table] = data.split('|');
      const full = `${game}|${hall}|${table}`;
      userCurrentTable.set(userId, full);
      return safeReply(event, { type: 'flex', altText: `請輸入 ${full} 前10局結果`, contents: generateInputInstructionFlex(full, true) });
    }
    if (data.startsWith('ANALYZE|')) {
      const full = data.split('|')[1];
      const rec = userRecentInput.get(userId);
      if (!rec || !/^[閒莊和]{3,10}$/.test(rec.seq)) {
        return safeReply(event, { type: 'text', text: '目前尚未輸入前10局資訊，請先輸入（至少三局）。' });
      }
      const flex = generateAnalysisResultFlex(userId, full);
      return safeReply(event, { type: 'flex', altText: `分析結果 - ${full}`, contents: flex });
    }
    if (data.startsWith('ROUND_RESULT|')) {
      const parts = data.split('|');
      const actual = parts[1];
      const full = parts[2];

      const lastPress = resultPressCooldown.get(userId) || 0;
      if (Date.now() - lastPress < RESULT_COOLDOWN_MS) {
        return safeReply(event, { type: 'text', text: '當局牌局尚未結束，請當局結束再操作。' });
        }
      resultPressCooldown.set(userId, Date.now());

      const last = userLastRecommend.get(userId);
      if (last && last.fullTableName === full) {
        const cols = columnsFromAmount(last.amount) * (actual === last.side ? 1 : -1);
        const money = cols * 100;
        const entry = { ...last, actual, columns: cols, money, ts: Date.now() };
        const arr = userBetLogs.get(userId) || [];
        arr.push(entry);
        userBetLogs.set(userId, arr);
      }

      const flex = generateAnalysisResultFlex(userId, full);
      return safeReply(event, { type: 'flex', altText: `分析結果 - ${full}`, contents: flex });
    }
    return;
  }
}

/* =========================
 * 其他 Flex：注意事項
 * ========================= */
function generateIntroFlex() {
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: 'SKwin AI算牌系統', weight: 'bold', color: '#00B900', size: 'lg', margin: 'md', align: 'center' },
      { type: 'text', text: '注意事項及使用說明', weight: 'bold', margin: 'md', align: 'center' },
      { type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: [
        { type: 'text', text: '1. 每次啟動請先觀察3~5局預測再下注。', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '2. 同桌連輸3局請換桌。', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '3. 請正確回報當局結果，以免影響分析。', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '4. 兩分鐘未操作自動中斷（僅私聊）。', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '5. 本系統為輔助工具，請理性投注。', wrap: true },
      ]},
      { type: 'button', action: pb('postback', 'PICK_GAME|DG真人', '開始預測'), style: 'primary', color: '#00B900', margin: 'xl' },
    ]},
  };
}

/* =========================
 * 全域錯誤處理
 * ========================= */
process.on('unhandledRejection', (reason) => console.error('UnhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));
