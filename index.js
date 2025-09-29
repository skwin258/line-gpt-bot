// index.js (Node 18+ / ESM)
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
 * 伺服器層優化：降低 499 機率
 * ========================= */
app.set('trust proxy', 1);
app.disable('x-powered-by');

let serverRef = null; // Node 原生 HTTP server keep-alive（在最下方 listen 後設定）

/* =========================
 * 使用者與管理員
 * ========================= */
const allowedUsers = new Set([
  'U48c33cd9a93a3c6ce8e15647b8c17f08',
  'Ufaeaa194b93281c0380cfbfd59d5aee0',
  'U73759fc9139edfaf7c804509d0a8c07f',
  'U63918f9d8b44770747034598a351595e',
  'U1cebd63109f62550c10df0ab835a900c', // << 也是管理員
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
const GROUP_ADMIN_UIDS = new Set([
  'U1cebd63109f62550c10df0ab835a900c',
]);

/* =========================
 * 狀態暫存（記憶體版）
 * ========================= */
// 私聊（自動版）
const userLastActiveTime = new Map();   // userId -> ts
const resultPressCooldown = new Map();  // userId -> ts
const userRecentInput = new Map();      // userId -> { seq, ts }
const qaModeUntil = new Map();          // userId -> ts
const handledEventIds = new Map();      // 去重

// 報表（私聊）
const userCurrentTable = new Map();   // userId -> fullTableName
const userLastRecommend = new Map();  // userId -> {...}
const userBetLogs = new Map();        // userId -> [ ... ]

// 群組（手動版）—不影響私聊自動版
const groupCurrentTable = new Map();   // groupId/roomId -> fullTableName
const groupLastRecommend = new Map();  // groupId/roomId -> {...}
const groupBetLogs = new Map();        // groupId/roomId -> [ ... ]
const groupAdminBinder = new Map();    // groupId/roomId -> adminUserId（最後操作的管理員）

// 基礎頻率限制
const userLastMsgAt = new Map(); // userId or composite -> ts
const USER_MIN_INTERVAL_MS = 250; // 0.25s

// TTL
const INACTIVE_MS = 2 * 60 * 1000;      // 2 分鐘未操作 => 視為中斷（僅私聊）
const RESULT_COOLDOWN_MS = 10 * 1000;   // 單局按鈕冷卻（僅私聊）
const QA_WINDOW_MS = 3 * 60 * 1000;     // 問答模式持續
const EVENT_DEDUPE_MS = 5 * 60 * 1000;  // 事件去重 TTL

/* =========================
 * 小工具
 * ========================= */
function isGroupLike(event) {
  return event?.source?.type === 'group' || event?.source?.type === 'room';
}
function getChatId(event) {
  if (event?.source?.type === 'group') return event?.source?.groupId;
  if (event?.source?.type === 'room') return event?.source?.roomId;
  return event?.source?.userId;
}
function isAdmin(userId) {
  return GROUP_ADMIN_UIDS.has(userId);
}

// 事件去重
function dedupeEvent(event) {
  const id = event?.deliveryContext?.isRedelivery
    ? `${event?.message?.id || event?.replyToken}-R`
    : (event?.message?.id || event?.replyToken || `${event?.timestamp || ''}-${Math.random()}`);

  const now = Date.now();
  for (const [k, ts] of handledEventIds) {
    if (ts <= now) handledEventIds.delete(k);
  }
  if (handledEventIds.has(id)) return true;
  handledEventIds.set(id, now + EVENT_DEDUPE_MS);
  return false;
}

// LINE API 呼叫重試器
async function withRetry(fn, { tries = 3, baseDelay = 150 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.statusCode || err?.originalError?.response?.status || err?.status;
      if (![429, 499, 500, 502, 503, 504].includes(status)) break;
      const delay = baseDelay * Math.pow(2, i) + Math.floor(Math.random() * 100);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// 安全回覆（reply 失敗改 push 到同一聊天室）
async function safeReply(event, messages) {
  if (!Array.isArray(messages)) messages = [messages];
  const replyToken = event.replyToken;

  const tryReply = async () => {
    try {
      await withRetry(() => client.replyMessage(replyToken, messages));
      return true;
    } catch {
      return false;
    }
  };

  let replied = false;
  try {
    replied = await tryReply();
  } catch {
    replied = false;
  }

  if (!replied) {
    const source = event?.source || {};
    let toId = null;
    if (source.type === 'group') toId = source.groupId;
    else if (source.type === 'room') toId = source.roomId;
    else toId = source.userId;

    if (!toId) return;
    await withRetry(() => client.pushMessage(toId, messages)).catch(() => {});
  }
}

// OpenAI 呼叫加超時（目前手動/自動都不強依賴）
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
  } finally {
    clearTimeout(timer);
  }
}

/* =========================
 * 遊戲資料（完整）
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
 * Flex 產生器（通用）
 * ========================= */
function generateHallSelectFlex(gameName) {
  const halls = Object.keys(tableData[gameName] || {});
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: `遊戲：${gameName}`, weight: 'bold', color: '#00B900', size: 'lg', align: 'center' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '請選擇遊戲廳', weight: 'bold', align: 'center', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          margin: 'lg',
          contents: halls.map((hall) => ({
            type: 'button',
            style: 'primary',
            color: '#00B900',
            action: { type: 'message', label: hall, text: `${gameName}|${hall}` },
          })),
        },
      ],
    },
  };
}

// 牌桌清單（含下一頁保護）
function generateTableListFlex(gameName, hallName, tables, page = 1, pageSize = 10) {
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, tables.length);
  const pageTables = tables.slice(startIndex, endIndex);

  const bubbles = pageTables.map((table) => ({
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: table, weight: 'bold', size: 'md', color: '#00B900' },
        { type: 'text', text: '進行中', size: 'sm', color: '#555555', margin: 'sm' },
        { type: 'text', text: `最低下注：100元`, size: 'sm', color: '#555555', margin: 'sm' },
        { type: 'text', text: `最高限額：10000元`, size: 'sm', color: '#555555', margin: 'sm' },
        { type: 'button', action: { type: 'message', label: '選擇', text: `選擇桌號|${gameName}|${hallName}|${table}` }, style: 'primary', color: '#00B900', margin: 'md' },
      ],
    },
  }));

  const carousel = { type: 'carousel', contents: bubbles };

  if (endIndex < tables.length) {
    carousel.contents.push({
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '還有更多牌桌，點擊下一頁', wrap: true, size: 'md', weight: 'bold', align: 'center' },
          { type: 'button', action: { type: 'message', label: '下一頁', text: `nextPage|${page + 1}|${gameName}|${hallName}` }, style: 'primary', color: '#00B900', margin: 'lg' },
        ],
      },
    });
  }
  return carousel;
}

function generateInputInstructionFlex(fullTableName) {
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '分析中', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
        { type: 'text', text: `桌號：${fullTableName}`, margin: 'md', color: '#555555' },
        { type: 'text', text: '請輸入前10局閒莊和的結果，最少需要輸入前三局，例:閒莊閒莊閒莊閒莊和閒', margin: 'md', color: '#555555', wrap: true },
        { type: 'button', action: { type: 'message', label: '開始分析', text: `開始分析|${fullTableName}` }, style: 'primary', color: '#00B900', margin: 'lg' },
      ],
    },
  };
}

function randHundreds(min, max) {
  const start = Math.ceil(min / 100);
  const end = Math.floor(max / 100);
  const pick = Math.floor(Math.random() * (end - start + 1)) + start;
  return pick * 100;
}
function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* =========================
 * 自動版：分析結果 Flex（含回報按鈕）
 * ========================= */
function generateAnalysisResultFlex(userIdOrKey, fullTableName, predicted = null) {
  const parts = String(fullTableName).split('|');
  const gameName = parts[0] || fullTableName;
  const hallName = parts[1] || '';
  const tableName = parts[2] || '';
  const isDragonTiger = hallName === '龍虎鬥';

  let mainPick;
  if (predicted && ((isDragonTiger && (predicted === '龍' || predicted === '虎')) || (!isDragonTiger && (predicted === '莊' || predicted === '閒')))) {
    mainPick = predicted;
  } else {
    const r = Math.random() * 100;
    mainPick = isDragonTiger ? (r < 50 ? '龍' : '虎') : (r < 50 ? '莊' : '閒');
  }

  const attachTieSmall = Math.random() < 0.05;
  const passRate = Math.floor(Math.random() * (90 - 45 + 1)) + 45;

  let betLevel = '觀望';
  let betAmount = 100;
  if (passRate <= 50) { betLevel = '觀望'; betAmount = 100; }
  else if (passRate <= 65) { betLevel = '小注'; betAmount = randHundreds(100, 1000); }
  else if (passRate <= 75) { betLevel = '中注'; betAmount = randHundreds(1100, 2000); }
  else { betLevel = '重注'; betAmount = randHundreds(2100, 3000); }

  // 記錄（自動/群組皆可重用此方法）
  const rec = {
    fullTableName,
    system: gameName,
    hall: hallName,
    table: tableName,
    side: mainPick,
    amount: betAmount,
    ts: Date.now(),
  };

  // 決定存放到 user or group（此函式傳入的是 userId 或 groupId/roomId）
  if (String(userIdOrKey).startsWith('group:') || String(userIdOrKey).startsWith('room:')) {
    groupCurrentTable.set(userIdOrKey.replace(/^group:|^room:/, ''), fullTableName);
    groupLastRecommend.set(userIdOrKey.replace(/^group:|^room:/, ''), rec);
  } else {
    userCurrentTable.set(userIdOrKey, fullTableName);
    userLastRecommend.set(userIdOrKey, rec);
  }

  const proReasonsGeneric = [
    `近期節奏偏${mainPick}，點數優勢與回補力度明顯，勝率估約${passRate}% ，資金可採階梯式進場。`,
    `路紙呈單邊延伸且波動收斂，${mainPick}佔優；以風險報酬比評估，${betLevel}較合理。`,
    `連動段落尚未轉折，${mainPick}方承接力強；量化指標偏多，建議依紀律${betLevel}。`,
    `盤勢慣性朝${mainPick}傾斜，短期優勢未被破壞；依趨勢交易邏輯，執行${betLevel}。`,
    `形態未出現反轉訊號，${mainPick}動能續航；配合分散下注原則，${betLevel}較佳。`,
  ];
  const tieReasons = [
    `點數拉鋸且對稱度提高，和局機率上緣提升；僅以極小資金對沖波動。`,
    `近期出現多次臨界點比拼，存在插針和局風險；建議和局小注防守。`,
    `節奏收斂、分差縮小，和局出現條件具備；以小注配置分散風險。`,
    `牌型分布有輕微對稱跡象，和局非主軸但可小試；資金控制為先。`,
  ];
  const mainReason = pickOne(proReasonsGeneric);
  const tieAddOn = attachTieSmall ? pickOne(tieReasons) : '';

  const leftBtnLabel  = isDragonTiger ? '龍' : '閒';
  const rightBtnLabel = isDragonTiger ? '虎' : '莊';

  const baseContents = [
    { type: 'text', text: '分析結果', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
    { type: 'text', text: `牌桌：${gameName}`, margin: 'md', color: '#555555' },
    { type: 'text', text: `預測結果為：${mainPick}（${betLevel}）${attachTieSmall ? ' 和小下' : ''}`, margin: 'md', size: 'md' },
    { type: 'text', text: `推薦下注金額：${betAmount} 元`, margin: 'md', size: 'md' },
    { type: 'text', text: `過關機率：約 ${passRate}%`, margin: 'md', size: 'md' },
    { type: 'text', text: `說明：${mainReason}`, margin: 'md', wrap: true },
  ];
  if (attachTieSmall) baseContents.push({ type: 'text', text: `和小下理由：${tieAddOn}`, margin: 'md', wrap: true });

  // 自動版需要回報按鈕
  baseContents.push({
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: 'md',
    contents: [
      { type: 'button', style: 'primary', color: '#2185D0', action: { type: 'message', label: leftBtnLabel, text: `當局結果為|${leftBtnLabel}|${fullTableName}` }, flex: 1 },
      { type: 'button', style: 'primary', color: '#21BA45', action: { type: 'message', label: '和', text: `當局結果為|和|${fullTableName}` }, flex: 1 },
      { type: 'button', style: 'primary', color: '#DB2828', action: { type: 'message', label: rightBtnLabel, text: `當局結果為|${rightBtnLabel}|${fullTableName}` }, flex: 1 },
    ],
  });

  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: baseContents },
  };
}

/* =========================
 * 手動版：管理員控制卡 & 公開結果卡
 * ========================= */
function generateAdminControlFlex(fullTableName, groupId) {
  const [, hallName] = String(fullTableName).split('|');
  const isDragonTiger = hallName === '龍虎鬥';
  const left = isDragonTiger ? '龍' : '閒';
  const right = isDragonTiger ? '虎' : '莊';

  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '管理員面板', weight: 'bold', size: 'lg', color: '#DB2828', align: 'center' },
        { type: 'text', text: `桌號：${fullTableName}`, margin: 'md' },
        { type: 'text', text: '請選擇本局預測：', margin: 'md' },
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'md',
          contents: [
            { type: 'button', style: 'primary', color: '#2185D0', action: { type: 'message', label: left,  text: `設定預測|${left}|${fullTableName}|${groupId}` }, flex: 1 },
            { type: 'button', style: 'primary', color: '#21BA45', action: { type: 'message', label: '和', text: `設定預測|和|${fullTableName}|${groupId}` }, flex: 1 },
            { type: 'button', style: 'primary', color: '#DB2828', action: { type: 'message', label: right, text: `設定預測|${right}|${fullTableName}|${groupId}` }, flex: 1 },
          ],
        },
        { type: 'text', text: '（僅供管理員使用，將以此預測發佈到群組）', margin: 'md', size: 'sm', color: '#777777' },
      ],
    },
  };
}

function extractSimpleTableName(table) {
  const m = /([A-Z]\d{2,3})$/i.exec(table || '');
  return m ? m[1].toUpperCase() : table || '';
}

// 群組公開展示卡（無按鈕，符合你的格式）
function generatePublicResultFlex({ system, hall, table, side, passRate, betAmount, betLevel, reason }) {
  const tableShort = extractSimpleTableName(table);
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: 'SKwin百家分析系統', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
        { type: 'text', text: 'Ai分析結果', weight: 'bold', align: 'center', margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: `本局預測：${side}（${betLevel}）`, margin: 'md' },
        { type: 'text', text: `牌桌：${system}/${tableShort}`, margin: 'sm' },
        { type: 'text', text: `勝率：${passRate}%`, margin: 'sm' },
        { type: 'text', text: `建議下注：${betAmount}元`, margin: 'sm' },
        { type: 'text', text: `說明：${reason}`, margin: 'sm', wrap: true },
      ],
    },
  };
}

// 依 side 產出建議（共用邏輯）
function computeRecommendation(side) {
  const passRate = Math.floor(Math.random() * (90 - 45 + 1)) + 45;
  let betLevel = '觀望';
  let betAmount = 100;
  if (passRate <= 50) { betLevel = '觀望'; betAmount = 100; }
  else if (passRate <= 65) { betLevel = '小注'; betAmount = randHundreds(100, 1000); }
  else if (passRate <= 75) { betLevel = '中注'; betAmount = randHundreds(1100, 2000); }
  else { betLevel = '重注'; betAmount = randHundreds(2100, 3000); }

  const reasons = [
    `形態未出現反轉訊號，${side}動能續航；配合分散下注原則，${betLevel}較佳。`,
    `近期節奏偏${side}，勝率估約${passRate}%；以風險報酬比衡量，採${betLevel}。`,
    `波動收斂、慣性未破壞，${side}佔優，建議${betLevel}執行。`,
    `短期趨勢朝${side}傾斜；紀律交易優先，${betLevel}配置。`,
  ];
  return { passRate, betLevel, betAmount, reason: pickOne(reasons) };
}

/* =========================
 * Flex 模組（注意事項 / 遊戲入口）
 * ========================= */
const flexMessageIntroJson = {
  type: 'bubble',
  body: {
    type: 'box',
    layout: 'vertical',
    contents: [
      { type: 'text', text: 'SKwin AI算牌系統', weight: 'bold', color: '#00B900', size: 'lg', margin: 'md', align: 'center' },
      { type: 'text', text: '注意事項及使用說明', weight: 'bold', margin: 'md', align: 'center' },
      {
        type: 'box',
        layout: 'vertical',
        margin: 'md',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '1. 每次啟動系統後，請先觀察3~5局預測結果，再開始下注。', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '2. 若在同一桌連續輸掉3局，建議立即換桌。', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '3. 請正確回報當局開獎結果，以免影響分析。', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '4. 兩分鐘未操作將自動中斷（私聊）。', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '5. 本系統為輔助工具，請理性投注。', wrap: true },
        ],
      },
      { type: 'button', action: { type: 'message', label: '開始預測', text: '開始預測' }, style: 'primary', color: '#00B900', margin: 'xl' },
    ],
  },
};

const flexMessageGameSelectJson = {
  type: 'bubble',
  body: {
    type: 'box',
    layout: 'vertical',
    contents: [
      { type: 'text', text: 'SKwin AI算牌系統', weight: 'bold', color: '#00B900', size: 'lg', align: 'center' },
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '請選擇遊戲', align: 'center', margin: 'md', weight: 'bold' },
      {
        type: 'box',
        layout: 'vertical',
        margin: 'lg',
        spacing: 'md',
        contents: [
          { type: 'button', style: 'primary', color: '#00B900', action: { type: 'message', label: 'DG真人', text: 'DG真人' } },
          { type: 'button', style: 'primary', color: '#00B900', action: { type: 'message', label: '歐博真人', text: '歐博真人' } },
          { type: 'button', style: 'primary', color: '#00B900', action: { type: 'message', label: '沙龍真人', text: '沙龍真人' } },
          { type: 'button', style: 'primary', color: '#00B900', action: { type: 'message', label: 'WM真人', text: 'WM真人' } },
        ],
      },
    ],
  },
};

/* =========================
 * 公開關鍵字（圖文選單用）
 * ========================= */
const CONTACT_REPLY_TEXT = `💥加入會員立刻領取5000折抵金💥
有任何疑問，客服隨時為您服務。
https://lin.ee/6kcsWNF`;

const MONTHLY_PROMO_IMAGES = [
  'https://i.ibb.co/8nS3tYvZ/photo-2025-08-10-01-34-12.jpg',
];

function buildMonthlyPromoMessages() {
  if (!Array.isArray(MONTHLY_PROMO_IMAGES) || MONTHLY_PROMO_IMAGES.length === 0) {
    return { type: 'text', text: '本月優惠圖片更新中，請稍後再試。' };
  }
  return MONTHLY_PROMO_IMAGES.slice(0, 5).map((u) => ({
    type: 'image',
    originalContentUrl: u,
    previewImageUrl: u,
  }));
}

function buildReportIntroFlex() {
  return {
    type: 'flex',
    altText: '報表功能',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '報表', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
          { type: 'text', text: '說明：100元為1柱', margin: 'sm' },
          { type: 'text', text: '按下「當局報表」即計算當前牌桌的勝負值', margin: 'sm', wrap: true },
          { type: 'text', text: '按下「本日報表」即計算今日12:00-23:59所有牌桌的勝負值', margin: 'sm', wrap: true },
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'md',
            margin: 'md',
            contents: [
              { type: 'button', style: 'primary', color: '#00B900', action: { type: 'message', label: '當局報表', text: '當局報表' }, flex: 1 },
              { type: 'button', style: 'primary', color: '#00B900', action: { type: 'message', label: '本日報表', text: '本日報表' }, flex: 1 },
            ],
          },
        ],
      },
    },
  };
}

function tryPublicKeyword(msg) {
  if (/^聯絡客服$/i.test(msg)) return { type: 'text', text: CONTACT_REPLY_TEXT };
  if (/^當月優惠$/i.test(msg)) return buildMonthlyPromoMessages();
  if (/^報表$/i.test(msg)) return buildReportIntroFlex();
  return null;
}

/* =========================
 * 報表工具
 * ========================= */
function buildRoundReportFlexCurrent(system, hall, table, totalAmount, sumColumns) {
  const money = sumColumns * 100;
  return {
    type: 'flex',
    altText: '當局報表',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '(當局報表)', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
          { type: 'text', text: `廳別：${hall}`, margin: 'sm' },
          { type: 'text', text: `桌別：${extractSimpleTableName(table)}`, margin: 'sm' },
          { type: 'text', text: `總下注金額：${totalAmount}`, margin: 'sm' },
          { type: 'text', text: `輸贏金額：${money >= 0 ? '+' : ''}${money}`, margin: 'sm' },
          { type: 'text', text: `柱碼：${sumColumns >= 0 ? '+' : ''}${sumColumns}柱`, margin: 'sm' },
        ],
      },
    },
  };
}

function buildDailyReportFlex(systems, tables, totalAmount, sumColumns) {
  const money = sumColumns * 100;
  return {
    type: 'flex',
    altText: '本日報表',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '(本日報表)', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
          { type: 'text', text: `系統：${systems.join('/')}`, margin: 'sm', wrap: true },
          { type: 'text', text: `桌別：${tables.map(extractSimpleTableName).join('/')}`, margin: 'sm', wrap: true },
          { type: 'text', text: `總下注金額：${totalAmount}`, margin: 'sm' },
          { type: 'text', text: `輸贏金額：${money >= 0 ? '+' : ''}${money}`, margin: 'sm' },
          { type: 'text', text: `柱碼：${sumColumns >= 0 ? '+' : ''}${sumColumns}柱`, margin: 'sm' },
        ],
      },
    },
  };
}

function columnsFromAmount(amount) { return Math.round(Number(amount || 0) / 100); }

function getTodayRangeTimestamp() {
  // 以 Asia/Taipei 時區換算今日 12:00–23:59:59.999
  const tz = 'Asia/Taipei';
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y, m, d] = fmt.split('-').map(n => parseInt(n, 10));
  const start = new Date(Date.UTC(y, m - 1, d, 4, 0, 0, 0));       // 台北 12:00 -> UTC+8 = 04:00 UTC
  const end   = new Date(Date.UTC(y, m - 1, d, 15, 59, 59, 999)); // 台北 23:59:59.999 -> 15:59:59.999 UTC
  return { startMs: +start, endMs: +end };
}

/* =========================
 * 路由
 * ========================= */
app.post('/webhook', middleware(config), async (req, res) => {
  res.status(200).end(); // 立刻回 200，避免 LINE 等待

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  for (const event of events) {
    if (dedupeEvent(event)) continue;

    // 基礎頻率限制：0.25s 內重複訊息直接忽略（避免連點）
    const throttleKey = `${getChatId(event)}:${event?.source?.userId || 'u'}`;
    const now = Date.now();
    const last = userLastMsgAt.get(throttleKey) || 0;
    if (now - last < USER_MIN_INTERVAL_MS) continue;
    userLastMsgAt.set(throttleKey, now);

    handleEvent(event).catch((err) => {
      console.error('事件處理錯誤:', err?.message || err);
    });
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
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const now = Date.now();
  const userId = event.source?.userId;
  const chatId = getChatId(event);
  const userMessage = String(event.message.text || '').trim();
  const inGroup = isGroupLike(event);

  // 公開關鍵字（不含權限 & 模式）
  const pub = tryPublicKeyword(userMessage);
  if (pub) return safeReply(event, pub);

  // 權限檢查（仍沿用 allowedUsers）
  if (!allowedUsers.has(userId)) {
    return safeReply(event, {
      type: 'text',
      text: `您沒有使用權限，請先開通會員。\n\n您的uid為：${userId}\n\n將此id回傳至skwin-註冊送5000\n完成註冊步驟即可獲得權限，謝謝。`,
    });
  }

  /* --------------------
   * 手動版（群組/社群）
   * -------------------- */
  if (inGroup) {
    // 群組：開始預測
    if (userMessage === '開始預測') {
      if (!isAdmin(userId)) {
        return safeReply(event, { type: 'text', text: '此群組為手動版，僅管理員可操作。請等待管理員開始分析。' });
      }
      return safeReply(event, { type: 'flex', altText: '請選擇遊戲（群組手動版）', contents: flexMessageGameSelectJson });
    }

    // 遊戲 -> 遊戲廳
    if (['DG真人', '歐博真人', '沙龍真人', 'WM真人'].includes(userMessage)) {
      if (!isAdmin(userId)) return; // 非管理員忽略
      const hallFlex = generateHallSelectFlex(userMessage);
      return safeReply(event, { type: 'flex', altText: `${userMessage} 遊戲廳選擇`, contents: hallFlex });
    }

    // 遊戲|遊戲廳 -> 牌桌清單
    if (userMessage.includes('|')) {
      const parts = userMessage.split('|');
      if (parts.length === 2) {
        if (!isAdmin(userId)) return;
        const [gameName, hallName] = parts;
        if (tableData[gameName] && tableData[gameName][hallName]) {
          const tables = tableData[gameName][hallName];
          const flexTables = generateTableListFlex(gameName, hallName, tables, 1);
          if (flexTables.contents?.length > 1) {
            const nextPageBubble = flexTables.contents[flexTables.contents.length - 1];
            const btn = nextPageBubble?.body?.contents?.find?.(c => c.type === 'button');
            if (btn) btn.action.text = `nextPage|2|${gameName}|${hallName}`;
          }
          return safeReply(event, { type: 'flex', altText: `${gameName} ${hallName} 牌桌列表 頁1`, contents: flexTables });
        }
      }
    }

    // 分頁
    if (userMessage.startsWith('nextPage|')) {
      if (!isAdmin(userId)) return;
      const parts = userMessage.split('|');
      if (parts.length === 4) {
        const page = parseInt(parts[1], 10);
        const gameName = parts[2];
        const hallName = parts[3];
        if (tableData[gameName] && tableData[gameName][hallName]) {
          const tables = tableData[gameName][hallName];
          const flexTables = generateTableListFlex(gameName, hallName, tables, page);
          if (flexTables.contents?.length > 1) {
            const nextPageBubble = flexTables.contents[flexTables.contents.length - 1];
            const btn = nextPageBubble?.body?.contents?.find?.(c => c.type === 'button');
            if (btn) btn.action.text = `nextPage|${page + 1}|${gameName}|${hallName}`;
          }
          return safeReply(event, { type: 'flex', altText: `${gameName} ${hallName} 牌桌列表 頁${page}`, contents: flexTables });
        }
      }
    }

    // 選擇桌號 -> 直接發管理員面板（DM）+ 群組提示
    if (userMessage.startsWith('選擇桌號|')) {
      if (!isAdmin(userId)) {
        return safeReply(event, { type: 'text', text: '只有管理員可以選擇桌號。' });
      }
      const parts = userMessage.split('|');
      const gameName = parts[1];
      const hallName = parts[2];
      const tableNumber = parts[3];
      const fullTableName = `${gameName}|${hallName}|${tableNumber}`;

      const groupKey = event.source.type === 'group' ? event.source.groupId : event.source.roomId;
      groupCurrentTable.set(groupKey, fullTableName);
      groupAdminBinder.set(groupKey, userId);

      // 提醒群組
      await safeReply(event, { type: 'text', text: `管理員已選擇桌別：${gameName}/${extractSimpleTableName(tableNumber)}，預測設定中…` });

      // DM 管理員面板
      const adminPanel = generateAdminControlFlex(fullTableName, groupKey);
      await withRetry(() => client.pushMessage(userId, [{ type: 'flex', altText: '管理員面板', contents: adminPanel }])).catch(() => {});
      return;
    }

    // 管理員在 DM 或 群組發出：設定預測|SIDE|FULL|GROUPID
    if (userMessage.startsWith('設定預測|')) {
      if (!isAdmin(userId)) return;
      const parts = userMessage.split('|');
      // 允許在群內（帶 groupId），也允許在私聊（必須帶 groupId）
      if (parts.length < 4) {
        return safeReply(event, { type: 'text', text: '格式錯誤。請使用：設定預測|莊(或閒/和/龍/虎)|系統|廳|桌|GROUPID' });
      }
      const side = parts[1];
      const fullTableName = parts.slice(2, parts.length - 1).join('|'); // 可能包含多個 |
      const targetGroupId = parts[parts.length - 1];

      const [system, hall, table] = fullTableName.split('|');
      // 產出建議
      const { passRate, betLevel, betAmount, reason } = computeRecommendation(side);

      // 記錄群組推薦
      groupLastRecommend.set(targetGroupId, {
        fullTableName,
        system, hall, table,
        side,
        amount: betAmount,
        ts: Date.now(),
      });

      // 發佈到群組（公開卡）
      const publicFlex = generatePublicResultFlex({ system, hall, table, side, passRate, betAmount, betLevel, reason });
      await withRetry(() => client.pushMessage(targetGroupId, [{ type: 'flex', altText: 'Ai分析結果', contents: publicFlex }])).catch(() => {});

      // 回覆管理員（私訊）—提供回報按鈕
      const isDragonTiger = hall === '龍虎鬥';
      const left = isDragonTiger ? '龍' : '閒';
      const right = isDragonTiger ? '虎' : '莊';
      const adminFollow = {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '已發佈到群組 ✅', weight: 'bold', align: 'center', color: '#00B900' },
            { type: 'text', text: `桌號：${fullTableName}`, margin: 'md' },
            { type: 'text', text: '請於開獎後回報當局結果：', margin: 'md' },
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'md',
              contents: [
                { type: 'button', style: 'primary', color: '#2185D0', action: { type: 'message', label: left,  text: `當局結果為|${left}|${fullTableName}|${targetGroupId}` }, flex: 1 },
                { type: 'button', style: 'primary', color: '#21BA45', action: { type: 'message', label: '和', text: `當局結果為|和|${fullTableName}|${targetGroupId}` }, flex: 1 },
                { type: 'button', style: 'primary', color: '#DB2828', action: { type: 'message', label: right, text: `當局結果為|${right}|${fullTableName}|${targetGroupId}` }, flex: 1 },
              ],
            },
          ],
        },
      };
      await withRetry(() => client.pushMessage(userId, [{ type: 'flex', altText: '回報當局結果', contents: adminFollow }])).catch(() => {});
      return;
    }

    // 群組報表（使用群組紀錄）
    if (userMessage === '當局報表') {
      const gId = event.source.type === 'group' ? event.source.groupId : event.source.roomId;
      const full = groupCurrentTable.get(gId);
      if (!full) return safeReply(event, { type: 'text', text: '尚未選擇牌桌，請管理員先選擇桌號。' });
      const [system, hall, table] = full.split('|');
      const logs = (groupBetLogs.get(gId) || []).filter(x => x.fullTableName === full);
      const totalAmount = logs.reduce((s, x) => s + (Number(x.amount) || 0), 0);
      const sumColumns = logs.reduce((s, x) => s + (Number(x.columns) || 0), 0);
      return safeReply(event, buildRoundReportFlexCurrent(system, hall, table, totalAmount, sumColumns));
    }
    if (userMessage === '本日報表') {
      const gId = event.source.type === 'group' ? event.source.groupId : event.source.roomId;
      const logs = groupBetLogs.get(gId) || [];
      const { startMs, endMs } = getTodayRangeTimestamp();
      const todayLogs = logs.filter(x => x.ts >= startMs && x.ts <= endMs);
      if (todayLogs.length === 0) {
        return safeReply(event, { type: 'text', text: '今日尚無可統計的投注紀錄（計算區間 12:00–23:59）。' });
      }
      const systems = [...new Set(todayLogs.map(x => x.system))];
      const tables  = [...new Set(todayLogs.map(x => x.table))];
      const totalAmount = todayLogs.reduce((s, x) => s + (Number(x.amount) || 0), 0);
      const sumColumns = todayLogs.reduce((s, x) => s + (Number(x.columns) || 0), 0);
      return safeReply(event, buildDailyReportFlex(systems, tables, totalAmount, sumColumns));
    }

    // 群組：其餘字串忽略（避免自動版的字元檢查誤觸）
    return;
  }

  /* --------------------
   * 自動版（私聊：原功能完整保留）
   * -------------------- */
  // 活躍檢查（僅私聊）
  const lastActive = userLastActiveTime.get(userId) || 0;
  const firstTime = lastActive === 0;
  if (!firstTime && now - lastActive > INACTIVE_MS) {
    userLastActiveTime.set(userId, now);
    await safeReply(event, [
      { type: 'text', text: '當次預測已中斷 請重新點選開始預測' },
      { type: 'flex', altText: 'SKwin AI算牌系統 注意事項', contents: flexMessageIntroJson },
    ]);
    return;
  }
  userLastActiveTime.set(userId, now);

  // 入口與說明
  if (userMessage === '會員開通' || userMessage === 'AI算牌說明') {
    return safeReply(event, { type: 'flex', altText: 'SKwin AI算牌系統 注意事項', contents: flexMessageIntroJson });
  }
  if (userMessage === '開始預測') {
    return safeReply(event, { type: 'flex', altText: '請選擇遊戲', contents: flexMessageGameSelectJson });
  }

  // 報表（私聊）
  if (userMessage === '當局報表') {
    const full = userCurrentTable.get(userId);
    if (!full) return safeReply(event, { type: 'text', text: '尚未選擇牌桌，請先選擇桌號後再查看當局報表。' });
    const [system, hall, table] = full.split('|');
    const logs = (userBetLogs.get(userId) || []).filter(x => x.fullTableName === full);
    const totalAmount = logs.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const sumColumns = logs.reduce((s, x) => s + (Number(x.columns) || 0), 0);
    return safeReply(event, buildRoundReportFlexCurrent(system, hall, table, totalAmount, sumColumns));
  }
  if (userMessage === '本日報表') {
    const logs = userBetLogs.get(userId) || [];
    const { startMs, endMs } = getTodayRangeTimestamp();
    const todayLogs = logs.filter(x => x.ts >= startMs && x.ts <= endMs);
    if (todayLogs.length === 0) {
      return safeReply(event, { type: 'text', text: '今日尚無可統計的投注紀錄（計算區間 12:00–23:59）。' });
    }
    const systems = [...new Set(todayLogs.map(x => x.system))];
    const tables  = [...new Set(todayLogs.map(x => x.table))];
    const totalAmount = todayLogs.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const sumColumns = todayLogs.reduce((s, x) => s + (Number(x.columns) || 0), 0);
    return safeReply(event, buildDailyReportFlex(systems, tables, totalAmount, sumColumns));
  }

  // 遊戲 -> 遊戲廳
  if (['DG真人', '歐博真人', '沙龍真人', 'WM真人'].includes(userMessage)) {
    const hallFlex = generateHallSelectFlex(userMessage);
    return safeReply(event, { type: 'flex', altText: `${userMessage} 遊戲廳選擇`, contents: hallFlex });
  }

  // 遊戲|遊戲廳 -> 牌桌清單（含分頁）
  if (userMessage.includes('|')) {
    const parts = userMessage.split('|');
    if (parts.length === 2) {
      const [gameName, hallName] = parts;
      if (tableData[gameName] && tableData[gameName][hallName]) {
        const tables = tableData[gameName][hallName];
        const flexTables = generateTableListFlex(gameName, hallName, tables, 1);
        if (flexTables.contents?.length > 1) {
          const nextPageBubble = flexTables.contents[flexTables.contents.length - 1];
          const btn = nextPageBubble?.body?.contents?.find?.(c => c.type === 'button');
          if (btn) btn.action.text = `nextPage|2|${gameName}|${hallName}`;
        }
        return safeReply(event, { type: 'flex', altText: `${gameName} ${hallName} 牌桌列表 頁1`, contents: flexTables });
      }
    }
  }

  // 分頁
  if (userMessage.startsWith('nextPage|')) {
    const parts = userMessage.split('|');
    if (parts.length === 4) {
      const page = parseInt(parts[1], 10);
      const gameName = parts[2];
      const hallName = parts[3];
      if (tableData[gameName] && tableData[gameName][hallName]) {
        const tables = tableData[gameName][hallName];
        const flexTables = generateTableListFlex(gameName, hallName, tables, page);
        if (flexTables.contents?.length > 1) {
          const nextPageBubble = flexTables.contents[flexTables.contents.length - 1];
          const btn = nextPageBubble?.body?.contents?.find?.(c => c.type === 'button');
          if (btn) btn.action.text = `nextPage|${page + 1}|${gameName}|${hallName}`;
        }
        return safeReply(event, { type: 'flex', altText: `${gameName} ${hallName} 牌桌列表 頁${page}`, contents: flexTables });
      }
    }
  }

  // 選擇桌號 -> 要求輸入前10局
  if (userMessage.startsWith('選擇桌號|')) {
    const parts = userMessage.split('|');
    const gameName = parts[1];
    const hallName = parts[2];
    const tableNumber = parts[3];
    const fullTableName = `${gameName}|${hallName}|${tableNumber}`;
    userCurrentTable.set(userId, fullTableName);
    return safeReply(event, { type: 'flex', altText: `請輸入 ${fullTableName} 前10局結果`, contents: generateInputInstructionFlex(fullTableName) });
  }

  // 非法字元防呆（排除報表關鍵字）
  const isReportKeyword = (userMessage === '當局報表' || userMessage === '本日報表');
  if (
    !isReportKeyword &&
    userMessage.length >= 1 &&
    userMessage.length <= 10 &&
    /^[\u4e00-\u9fa5]+$/.test(userMessage) &&
    !/^[閒莊和]+$/.test(userMessage)
  ) {
    return safeReply(event, { type: 'text', text: '偵測到無效字元，請僅使用「閒 / 莊 / 和」輸入，例：閒莊閒莊閒。' });
  }

  // 接收前10局（3~10字）
  if (/^[閒莊和]{3,10}$/.test(userMessage)) {
    userRecentInput.set(userId, { seq: userMessage, ts: now });
    return safeReply(event, { type: 'text', text: '已接收前10局結果，請點擊「開始分析」按鈕開始計算。' });
  }

  // 僅輸入「閒莊和」但不足條件
  if (/^[閒莊和]+$/.test(userMessage)) {
    return safeReply(event, {
      type: 'text',
      text: '目前尚未輸入前10局內結果資訊， 無法為您做詳細分析，請先輸入前10局內閒莊和的結果，最少需要輸入前三局的結果，例:閒莊閒莊閒閒和莊。',
    });
  }

  // 開始分析（私聊）
  if (userMessage.startsWith('開始分析|')) {
    const fullTableName = userMessage.split('|')[1];
    const rec = userRecentInput.get(userId);
    if (!rec || !/^[閒莊和]{3,10}$/.test(rec.seq)) {
      return safeReply(event, {
        type: 'text',
        text: '目前尚未輸入前10局內結果資訊， 無法為您做詳細分析，請先輸入前10局內閒莊和的結果，最少需要輸入前三局的結果，例:閒莊閒莊閒閒和莊。',
      });
    }
    const analysisResultFlex = generateAnalysisResultFlex(userId, fullTableName);
    return safeReply(event, { type: 'flex', altText: `分析結果 - ${fullTableName}`, contents: analysisResultFlex });
  }

  // 回報當局結果（私聊）
  if (userMessage.startsWith('當局結果為|')) {
    const parts = userMessage.split('|');
    // 允許 3 段（私聊）或 4 段（群組管理員私訊回報）
    if (parts.length === 3 || parts.length === 4) {
      const actual = parts[1];
      const fullTableName = parts[2];
      const targetGroupId = parts[3]; // 可能是 undefined（私聊）

      if (targetGroupId) {
        // 管理員私訊回報群組
        if (!isAdmin(userId)) return;
        const last = groupLastRecommend.get(targetGroupId);
        if (last && last.fullTableName === fullTableName) {
          const cols = columnsFromAmount(last.amount) * (actual === last.side ? 1 : -1);
          const money = cols * 100;
          const entry = { ...last, actual, columns: cols, money, ts: Date.now() };
          const arr = groupBetLogs.get(targetGroupId) || [];
          arr.push(entry);
          groupBetLogs.set(targetGroupId, arr);
        }
        // 推播群組下一張（選擇由管理員再發）—此處先不自動連續發：保持簡潔
        return safeReply(event, { type: 'text', text: '已回報群組當局結果 ✅' });
      }

      // 私聊記錄
      const lastPress = resultPressCooldown.get(userId) || 0;
      if (Date.now() - lastPress < RESULT_COOLDOWN_MS) {
        return safeReply(event, { type: 'text', text: '當局牌局尚未結束，請當局牌局結束再做操作。' });
      }
      resultPressCooldown.set(userId, Date.now());

      const last = userLastRecommend.get(userId);
      if (last && last.fullTableName === fullTableName) {
        const cols = columnsFromAmount(last.amount) * (actual === last.side ? 1 : -1);
        const money = cols * 100;
        const entry = { ...last, actual, columns: cols, money, ts: Date.now() };
        const arr = userBetLogs.get(userId) || [];
        arr.push(entry);
        userBetLogs.set(userId, arr);
      }

      const analysisResultFlex = generateAnalysisResultFlex(userId, fullTableName);
      return safeReply(event, { type: 'flex', altText: `分析結果 - ${fullTableName}`, contents: analysisResultFlex });
    }
  }

  // 問答模式（沿用）
  if (userMessage.startsWith('AI問與答')) {
    qaModeUntil.set(userId, now + QA_WINDOW_MS);
    const q = userMessage.replace(/^AI問與答\s*/, '').trim();
    if (!q) return safeReply(event, { type: 'text', text: '請問您想詢問甚麼主題或是具體問題呢?' });
    const replyText = await callOpenAIWithTimeout([{ role: 'user', content: q }]);
    return safeReply(event, { type: 'text', text: replyText });
  }
  const qaUntil = qaModeUntil.get(userId) || 0;
  if (now < qaUntil) {
    const replyText = await callOpenAIWithTimeout([{ role: 'user', content: userMessage }]);
    return safeReply(event, { type: 'text', text: replyText });
  }

  // 預設回覆（私聊）
  return safeReply(event, { type: 'text', text: '已關閉問答模式，需要開啟請輸入關鍵字。' });
}

/* =========================
 * 全域錯誤處理（避免程序當機）
 * ========================= */
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err);
});
