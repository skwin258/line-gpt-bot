// index.js (Node 18+ / ESM) — 個人私聊版（含系統圖片卡 + 桌別狀態 + 分頁規則 + 20局/至少6局 + 珠盤預覽 + 合併卡）
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
let serverRef = null;

/* =========================
 * 使用者白名單
 * ========================= */
const allowedUsers = new Set([
  'U48c33cd9a93a3c6ce8e15647b8c17f08',
  'Ufaeaa194b93281c0380cfbfd59d5aee0',
  'U73759fc9139edfaf7c804509d0a8c07f',
  'U63918f9d8b44770747034598a351595e',
  'U1cebd63109f62550c10df0ab835a900c', // 超級管理員
  'U0ea07940728c64ae26385f366b5b9603',
  'U35cf199d3a707137efed545d782e11c0',
  'Udbc76d0c8fab9a80a1c6a7ef12ac5e81',
  'Uc3be515b0b2e4c8807ad8552d40d1714',
  'Uf7c1ad44ebc11e81cb24a2a38b9f3b39',
  'U2031c52d282931d135d54e21c5657184',
  'U3cdee5d82468e9f9c43ae83c5cc70000',
  'U894e1dbe11c2011df54d5b34fce66884',
  'U6dcf6ed0c8677c2e63ff98e63069e88a',
  'Ud19fd8e4d6613c269b2828093f26a313',
  'Ud610a88346ca761ce491a62d9b9c0000',
  'U1acf997bbbed247c1a2c7605ce9e0000',
  'U52dba780e8908d86ee340d1dc22569f0',
  'U92153cd0bc1c4f2b58c2f554b4f00000',
  'Ua7c28253f2ead5aafbbc76e6d062cfe7',
]);

/* =========================
 * 狀態暫存（僅私聊）
 * ========================= */
const userLastActiveTime = new Map(); // 最近互動時間
const resultPressCooldown = new Map(); // 回報節流
const userRecentInput = new Map(); // { seq, ts, full } 暫存前20局
const handledEventIds = new Map(); // 去重

// 報表（私聊）
const userCurrentTable = new Map();
const userLastRecommend = new Map();
const userBetLogs = new Map();

// 節流
const userLastMsgAt = new Map();
const USER_MIN_INTERVAL_MS = 250;

// TTL
const INACTIVE_MS = 2 * 60 * 1000;
const RESULT_COOLDOWN_MS = 10 * 1000;

/* =========================
 * 小工具
 * ========================= */
const getChatId = (e) => e?.source?.userId;

function dedupeEvent(event) {
  const id = event?.deliveryContext?.isRedelivery
    ? `${event?.message?.id || event?.replyToken}-R`
    : (event?.message?.id || event?.replyToken || `${event?.timestamp || ''}-${Math.random()}`);
  const now = Date.now();
  for (const [k, ts] of handledEventIds) if (ts <= now) handledEventIds.delete(k);
  if (handledEventIds.has(id)) return true;
  handledEventIds.set(id, now + 5 * 60 * 1000);
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
    const to = event?.source?.userId;
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
  MT真人: {
    中文廳: ['百家樂1','百家樂2','百家樂3','百家樂4','百家樂5','百家樂6','百家樂7','百家樂8','百家樂9','百家樂10'],
    亞洲廳: ['百家樂11','百家樂12','百家樂13'],
  },
  金佰新百家: {
    亞洲廳: ['亞洲1廳','亞洲2廳','亞洲3廳','亞洲4廳','亞洲5廳','亞洲6廳','亞洲7廳','亞洲8廳','亞洲9廳','亞洲10廳','亞洲11廳','亞洲12廳'],
    貴賓廳: ['貴賓1廳','貴賓2廳'],
  },
};

/* =========================
 * Flex 產生器（僅私聊）
 * ========================= */

// 圖片卡的資料（可改順序）
const SYSTEM_CARDS = [
  { actionText: 'DG真人', image: 'https://bc78999.com/wp-content/uploads/2025/10/dg-baccarat-300x300.jpg' },
  { actionText: 'MT真人', image: 'https://bc78999.com/wp-content/uploads/2025/10/mt-baccarat-300x300.jpg' },
  { actionText: '歐博真人', image: 'https://bc78999.com/wp-content/uploads/2025/10/ou-bo-baccarat-300x300.jpg' },
  { actionText: '沙龍真人', image: 'https://bc78999.com/wp-content/uploads/2025/10/sha-long-baccarat-300x300.jpg' },
  { actionText: 'WM真人', image: 'https://bc78999.com/wp-content/uploads/2025/10/wm-baccarat-300x300.jpg' },
  { actionText: '金佰新百家', image: 'https://bc78999.com/wp-content/uploads/2025/10/jinbaixin-baccarat-300x300.jpg' },
];

// 系統選擇：小卡（圖片滿版）Carousel
function buildSystemSelectCarousel() {
  const bubbles = SYSTEM_CARDS.map((c) => ({
    type: 'bubble',
    size: 'nano', // 小卡
    hero: { type: 'image', url: c.image, size: 'full', aspectRatio: '1:1', aspectMode: 'cover' },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', color: '#00B900', action: { type: 'message', label: '選擇', text: c.actionText } },
      ],
    },
  }));
  return { type: 'carousel', contents: bubbles };
}

function generateHallSelectFlex(gameName) {
  const halls = Object.keys(tableData[gameName] || {});
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: `遊戲：${gameName}`, weight: 'bold', color: '#00B900', size: 'lg', align: 'center' },
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '請選擇遊戲廳', weight: 'bold', align: 'center', margin: 'md' },
      { type: 'box', layout: 'vertical', spacing: 'md', margin: 'lg', contents:
        halls.map(hall => ({
          type: 'button', style: 'primary', color: '#00B900',
          action: { type: 'message', label: hall, text: `${gameName}|${hall}` },
        }))
      },
    ]},
  };
}

// ===== 狀態標籤工具（每桌一定有狀態）=====
function buildStatusListForHall(
  tables,
  { hotP = 0.18, recP = 0.22 } = {}
) {
  return tables.map(() => {
    const r = Math.random();
    if (r < hotP) return '熱門🔥';
    if (r < hotP + recP) return '推薦✅';
    return '進行中';
  });
}

// 牌桌列表（含狀態標籤 + 新分頁規則）
function generateTableListFlex(gameName, hallName, tables, page = 1, pageSize = 10) {
  const statusList = buildStatusListForHall(tables);
  const startIndex = (page - 1) * pageSize;
  const endIndex   = Math.min(startIndex + pageSize, tables.length);
  const pageTables = tables.slice(startIndex, endIndex);

  const bubbles = pageTables.map((table, idxOnPage) => {
    const idxAll = startIndex + idxOnPage;
    const status = statusList[idxAll];
    const contents = [
      { type: 'text', text: table, weight: 'bold', size: 'md', color: '#00B900' },
    ];
    if (status) contents.push({ type: 'text', text: status, size: 'sm', color: '#666666', margin: 'sm' });
    contents.push(
      { type: 'text', text: '最低下注：100元', size: 'sm', color: '#555555', margin: 'sm' },
      { type: 'text', text: '最高限額：10000元', size: 'sm', color: '#555555', margin: 'sm' },
      {
        type: 'button',
        action: { type: 'message', label: '選擇', text: `選擇桌號|${gameName}|${hallName}|${table}` },
        style: 'primary', color: '#00B900', margin: 'md'
      }
    );
    return { type: 'bubble', body: { type: 'box', layout: 'vertical', contents } };
  });

  const carousel = { type: 'carousel', contents: bubbles };
  if (endIndex < tables.length) {
    carousel.contents.push({
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: '還有更多牌桌，點擊下一頁', wrap: true, size: 'md', weight: 'bold', align: 'center' },
        { type: 'button', action: { type: 'message', label: '下一頁', text: `nextPage|${page + 1}|${gameName}|${hallName}` }, style: 'primary', color: '#00B900', margin: 'lg' },
      ]},
    });
  }
  return carousel;
}

/* =========================
 * 文字珠盤工具（新增）
 * ========================= */
const EMOJI = { '閒':'🔵', '莊':'🔴', '和':'🟢', '龍':'🔵', '虎':'🔴' };

/** 直列高度6；先填滿第一欄再換下一欄（兩欄視覺） */
function toBeadRows(seq) {
  const icons = [...String(seq)].map(c => EMOJI[c] || '');
  const rows = [];
  for (let i = 0; i < icons.length; i += 2) rows.push(icons.slice(i, i + 2).join(' '));
  return rows;
}
function beadplateFlex(seq, title = '當前珠盤路', subtitle = '') {
  const rows = toBeadRows(seq);
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing:'sm', contents: [
      { type: 'text', text: title, weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
      ...(subtitle ? [{ type:'text', text: subtitle, size:'sm', color:'#666666', wrap:true, margin:'sm' }] : []),
      { type:'separator', margin:'md' },
      ...rows.map(t => ({ type:'text', text:t, size:'md', margin:'xs' })),
    ]},
  };
}
// 輸入後第一張「預覽卡」＋ 開始分析
function beadplatePreviewFlex(seq, fullTableName) {
  const subtitle = '說明:請確認當下遊戲內珠盤路順序與下方一致，確認一致再點擊開始分析，以避免系統錯誤判斷。';
  const base = beadplateFlex(seq, '當前珠盤路', subtitle);
  base.body.contents.push(
    { type:'separator', margin:'md' },
    { type:'button', style:'primary', color:'#00B900', margin:'md',
      action:{ type:'message', label:'開始分析', text:`開始分析|${fullTableName}` } }
  );
  return base;
}
// 回報後「合併卡」：上半珠盤 + 下半分析 + 三鍵
function combinedBeadplateAndAnalysisFlex({ seq, fullTableName, systemName, mainPick, betLevel, betAmount, passRate, reason, isDragonTiger }) {
  const rows = toBeadRows(seq);
  const leftBtnLabel  = isDragonTiger ? '龍' : '閒';
  const rightBtnLabel = isDragonTiger ? '虎' : '莊';
  return {
    type:'bubble',
    body:{ type:'box', layout:'vertical', contents:[
      { type:'text', text:'當前珠盤路', size:'lg', weight:'bold', color:'#00B900', align:'center' },
      { type:'text', text:'如果與當前不一致，請重新輸入。', size:'sm', color:'#666666', wrap:true, margin:'sm' },
      { type:'separator', margin:'md' },
      ...rows.map(t => ({ type:'text', text:t, size:'md', margin:'xs' })),
      { type:'separator', margin:'md' },

      { type:'text', text:'分析結果', size:'lg', weight:'bold', color:'#00B900', align:'center', margin:'md' },
      { type:'text', text:`牌桌：${systemName}`, margin:'sm' },
      { type:'text', text:`預測結果：${mainPick}（${betLevel}）`, margin:'sm' },
      { type:'text', text:`推薦下注金額：${betAmount} 元`, margin:'sm' },
      { type:'text', text:`過關機率：約 ${passRate}%`, margin:'sm' },
      { type:'text', text:`說明：${reason}`, margin:'sm', wrap:true },

      { type:'box', layout:'horizontal', spacing:'md', margin:'md', contents:[
        { type:'button', style:'primary', color:'#2185D0', action:{ type:'message', label:leftBtnLabel,  text:`當局結果為|${leftBtnLabel}|${fullTableName}` }, flex:1 },
        { type:'button', style:'primary', color:'#21BA45', action:{ type:'message', label:'和',          text:`當局結果為|和|${fullTableName}` }, flex:1 },
        { type:'button', style:'primary', color:'#DB2828', action:{ type:'message', label:rightBtnLabel, text:`當局結果為|${rightBtnLabel}|${fullTableName}` }, flex:1 },
      ]},
    ]}
  };
}

function generateInputInstructionFlex(fullTableName) {
  // 改為純說明（輸入後才會有「開始分析」按鈕）
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '分析中', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
      { type: 'text', text: `桌號：${fullTableName}`, margin: 'md', color: '#555555' },
      { type: 'text', text: '請輸入前20局「閒/莊/和」，最少輸入 6 局。例如：閒莊閒閒莊和閒……\n送出後會先顯示珠盤預覽，再點【開始分析】。', margin: 'md', color: '#555555', wrap: true },
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

/* =========================
 * 個人私聊：分析結果 Flex（含回報按鈕）
 * ========================= */
function generateAnalysisResultFlex(userId, fullTableName, predicted = null) {
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

  const rec = { fullTableName, system: gameName, hall: hallName, table: tableName, side: mainPick, amount: betAmount, ts: Date.now() };
  userCurrentTable.set(userId, fullTableName);
  userLastRecommend.set(userId, rec);

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
      { type: 'button', style: 'primary', color: '#2185D0', action: { type: 'message', label: leftBtnLabel,  text: `當局結果為|${leftBtnLabel}|${fullTableName}` }, flex: 1 },
      { type: 'button', style: 'primary', color: '#21BA45', action: { type: 'message', label: '和',          text: `當局結果為|和|${fullTableName}` }, flex: 1 },
      { type: 'button', style: 'primary', color: '#DB2828', action: { type: 'message', label: rightBtnLabel, text: `當局結果為|${rightBtnLabel}|${fullTableName}` }, flex: 1 },
    ],
  });

  return { type: 'bubble', body: { type: 'box', layout: 'vertical', contents } };
}

/* =========================
 * 注意事項 / 報表卡
 * ========================= */
const flexMessageIntroJson = {
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
    { type: 'button', action: { type: 'message', label: '開始預測', text: '開始預測' }, style: 'primary', color: '#00B900', margin: 'xl' },
  ]},
};

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
          {
            type: 'box',
            layout: 'vertical',
            margin: 'sm',
            spacing: 'xs',
            contents: [
              { type: 'text', text: '說明：報表採柱碼制。', wrap: true },
              { type: 'text', text: '（100 元 = 1 柱）', wrap: true },
              { type: 'text', text: '1. 總下注金額：所有投注合計。', wrap: true },
              { type: 'text', text: '2. 柱碼：淨勝負柱數。', wrap: true },
              { type: 'text', text: '3. 輸贏金額：柱碼 × 100。', wrap: true },
            ],
          },
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

const CONTACT_REPLY_TEXT = `💥加入會員立刻領取5000折抵金💥
有任何疑問，客服隨時為您服務。
https://lin.ee/6kcsWNF`;

function tryPublicKeyword(msg) {
  if (/^聯絡客服$/i.test(msg)) return { type: 'text', text: CONTACT_REPLY_TEXT };
  if (/^報表$/i.test(msg)) return buildReportIntroFlex();
  return null;
}

/* =========================
 * 報表工具（私聊）
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
function columnsFromAmount(amount) { return Math.round(Number(amount || 0) / 100); }
function getTodayRangeTimestamp() {
  const tz = 'Asia/Taipei'; const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y,m,d] = fmt.split('-').map(n=>parseInt(n,10));
  const start = new Date(Date.UTC(y, m-1, d, 4, 0, 0, 0));
  const end   = new Date(Date.UTC(y, m-1, d, 15, 59, 59, 999));
  return { startMs:+start, endMs:+end };
}

/* =========================
 * 路由
 * ========================= */
app.post('/webhook', middleware(config), async (req, res) => {
  res.status(200).end();

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  for (const event of events) {
    if (dedupeEvent(event)) continue;

    const throttleKey = getChatId(event) || 'u';
    const now = Date.now();
    const last = userLastMsgAt.get(throttleKey) || 0;
    if (now - last < USER_MIN_INTERVAL_MS) continue;
    userLastMsgAt.set(throttleKey, now);

    handleEvent(event).catch((err) => console.error('事件處理錯誤:', err?.message || err));
  }
});

app.get('/', (_req, res) => res.send('OK'));
const PORT = process.env.PORT || 3000;
serverRef = app.listen(PORT, () => console.log(`Server running on ${PORT}`));
serverRef.keepAliveTimeout = 65000;
serverRef.headersTimeout = 66000;

/* =========================
 * 事件處理（僅私聊）
 * ========================= */
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const now = Date.now();
  const userId = event.source?.userId;
  const userMessage = String(event.message.text || '').trim();

  // 公開關鍵字
  const pub = tryPublicKeyword(userMessage);
  if (pub) return safeReply(event, pub);

  // 白名單
  if (!allowedUsers.has(userId)) {
    return safeReply(event, {
      type: 'text',
      text: `您沒有使用權限，請先開通會員。\n\n您的uid為：${userId}\n\n將此id回傳至skwin-註冊送5000\n完成註冊步驟即可獲得權限，謝謝。`,
    });
  }

  // 連線超時保護：兩分鐘未操作則重置
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

  // 主動入口
  if (userMessage === '會員開通' || userMessage === 'AI算牌說明') {
    return safeReply(event, { type: 'flex', altText: 'SKwin AI算牌系統 注意事項', contents: flexMessageIntroJson });
  }
  if (userMessage === '開始預測') {
    // 換系統前情境：清空
    userRecentInput.delete(userId);
    userCurrentTable.delete(userId);
    return safeReply(event, {
      type: 'flex',
      altText: '請選擇系統',
      contents: buildSystemSelectCarousel()
    });
  }

  // 報表入口
  if (userMessage === '報表') {
    return safeReply(event, buildReportIntroFlex());
  }

  // === 報表：工具與「當局報表」處理 =======================
  function getLastLogForUser(uid) {
    const logs = userBetLogs.get(uid) || [];
    if (logs.length === 0) return null;
    let last = logs[0];
    for (const x of logs) if ((x?.ts || 0) > (last?.ts || 0)) last = x;
    return last;
  }
  function parseFullTableSafe(full) {
    if (!full || typeof full !== 'string') return { system: '', hall: '', table: '' };
    const parts = full.split('|');
    return { system: parts[0] ?? '', hall: parts[1] ?? '', table: parts[2] ?? '' };
  }

  // 當局報表
  if (/^\s*當局報表\s*$/.test(userMessage)) {
    const logsAll = userBetLogs.get(userId) || [];
    const lastRec = userLastRecommend.get(userId) || null;
    const fullSel = userCurrentTable.get(userId) || null;

    let targetFull =
      (lastRec && lastRec.fullTableName) ? lastRec.fullTableName :
      (fullSel ? fullSel :
      (logsAll.length ? (logsAll.reduce((a,b)=>((a?.ts||0)>(b?.ts||0)?a:b)).fullTableName || '') : ''));

    function smartParse(full) {
      if (!full || typeof full !== 'string') return { system:'', hall:'', table:'' };
      const p = full.split('|');
      let system = p[0] ?? '';
      let hall   = p[1] ?? '';
      let table  = p[2] ?? '';
      const candidate = table || p[p.length - 1];
      if (!hall || !system) {
        outer:
        for (const [sys, halls] of Object.entries(tableData)) {
          for (const [hallName, list] of Object.entries(halls)) {
            if (list.includes(candidate)) {
              if (!system) system = sys;
              if (!hall)   hall   = hallName;
              if (!table)  table  = candidate;
              break outer;
            }
          }
        }
      }
      return { system, hall, table };
    }

    if (!targetFull && logsAll.length) {
      const lastLog = logsAll.reduce((a,b)=>((a?.ts||0)>(b?.ts||0)?a:b));
      if (lastLog?.system || lastLog?.hall || lastLog?.table) {
        targetFull = [lastLog.system,lastLog.hall,lastLog.table].filter(Boolean).join('|');
      } else if (lastLog?.table) {
        targetFull = lastLog.table;
      }
    }

    const parsed = smartParse(targetFull);
    let { system, hall, table } = parsed;

    if (!system && !hall && !table) {
      return safeReply(event, { type: 'text', text: '尚未選擇牌桌，請先選擇桌號後再查看當局報表。' });
    }

    const logs = targetFull && targetFull.includes('|')
      ? logsAll.filter(x => x.fullTableName === targetFull)
      : logsAll.filter(x =>
          (x.fullTableName === targetFull) ||
          (x.system === system && x.hall === hall && x.table === table) ||
          (x.table === table)
        );

    const totalAmount = logs.reduce((s, x) => s + (Number(x.amount)  || 0), 0);
    const sumColumns  = logs.reduce((s, x) => s + (Number(x.columns) || 0), 0);

    return safeReply(
      event,
      buildRoundReportFlexCurrent(system || '未指定', hall || '未指定', table || '未指定', totalAmount, sumColumns)
    );
  }

  // 本日報表
  if (/^\s*本日報表\s*$/.test(userMessage)) {
    const logs = userBetLogs.get(userId) || [];
    const { startMs, endMs } = getTodayRangeTimestamp();
    const todayLogs = logs.filter(x => x.ts >= startMs && x.ts <= endMs);

    if (todayLogs.length === 0) {
      return safeReply(event, { type: 'text', text: '今日尚無可統計的投注紀錄（計算區間 12:00–23:59）。' });
    }

    const systems = [...new Set(todayLogs.map(x => x.system).filter(Boolean))];
    const tables  = [...new Set(todayLogs.map(x => x.table ).filter(Boolean))];
    const totalAmount = todayLogs.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const sumColumns  = todayLogs.reduce((s, x) => s + (Number(x.columns) || 0), 0);

    return safeReply(event, buildDailyReportFlex(systems, tables, totalAmount, sumColumns));
  }

  // 私聊：選單流程（系統 → 廳）
  const gameKeys = Object.keys(tableData);
  if (gameKeys.includes(userMessage)) {
    // 換系統 → 強制重新輸入
    userRecentInput.delete(userId);
    userCurrentTable.delete(userId);

    const hallFlex = generateHallSelectFlex(userMessage);
    return safeReply(event, { type: 'flex', altText: `${userMessage} 遊戲廳選擇`, contents: hallFlex });
  }

  // 廳 → 桌列表
  if (userMessage.includes('|')) {
    const parts = userMessage.split('|');
    if (parts.length === 2) {
      const [gameName, hallName] = parts;
      if (tableData[gameName] && tableData[gameName][hallName]) {
        const tables = tableData[gameName][hallName];
        const flexTables = generateTableListFlex(gameName, hallName, tables, 1);
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
        return safeReply(event, { type: 'flex', altText: `${gameName} ${hallName} 牌桌列表 頁${page}`, contents: flexTables });
      }
    }
  }

  // 選擇桌號 -> 要求輸入前20局（最少6局）
  if (userMessage.startsWith('選擇桌號|')) {
    const parts = userMessage.split('|');
    const gameName = parts[1];
    const hallName = parts[2];
    const tableNumber = parts[3];
    const fullTableName = `${gameName}|${hallName}|${tableNumber}`;

    userCurrentTable.set(userId, fullTableName);
    userRecentInput.delete(userId); // 換房/桌 → 強制清空

    return safeReply(event, { type: 'flex', altText: `請輸入 ${fullTableName} 前20局結果`, contents: generateInputInstructionFlex(fullTableName) });
  }

  // 非法字元防呆
  const isReportKeyword = (userMessage === '當局報表' || userMessage === '本日報表' || userMessage === '報表');
  if (!isReportKeyword &&
      userMessage.length >= 1 && userMessage.length <= 20 &&
      /^[\u4e00-\u9fa5]+$/.test(userMessage) && !/^[閒莊和]+$/.test(userMessage)) {
    return safeReply(event, { type: 'text', text: '偵測到無效字元，請僅使用「閒 / 莊 / 和」輸入，例：閒莊閒莊閒。' });
  }

  // 接收前20局（6~20字）→ 回「珠盤預覽 + 開始分析」
  if (/^[閒莊和]{6,20}$/.test(userMessage)) {
    const full = userCurrentTable.get(userId) || '';
    if (!full) {
      return safeReply(event, { type:'text', text:'請先選擇系統與桌號。' });
    }
    userRecentInput.set(userId, { seq: userMessage, ts: now, full });
    return safeReply(event, {
      type: 'flex',
      altText: '珠盤預覽',
      contents: beadplatePreviewFlex(userMessage, full)
    });
  }

  // 僅輸入但不足條件
  if (/^[閒莊和]+$/.test(userMessage)) {
    return safeReply(event, {
      type: 'text',
      text: '目前尚未達最少 6 局，請一次輸入 6~20 個字的「閒/莊/和」。',
    });
  }

  // 開始分析（私聊）
  if (userMessage.startsWith('開始分析|')) {
    const fullTableName = userMessage.split('|')[1];
    const rec = userRecentInput.get(userId);
    if (!rec || rec.full !== fullTableName || !/^[閒莊和]{6,20}$/.test(rec.seq)) {
      return safeReply(event, {
        type: 'text',
        text: '目前尚未輸入此桌的有效序列（需 6~20 局）。請重新輸入後再按【開始分析】。',
      });
    }
    const analysisResultFlex = generateAnalysisResultFlex(userId, fullTableName);
    return safeReply(event, { type: 'flex', altText: `分析結果 - ${fullTableName}`, contents: analysisResultFlex });
  }

  // 回報當局結果（私聊）→ 回「合併卡」（珠盤 + 分析）
  if (userMessage.startsWith('當局結果為|')) {
    const parts = userMessage.split('|');
    if (parts.length === 3) {
      const nowTs = Date.now();
      const lastPress = resultPressCooldown.get(userId) || 0;
      if (nowTs - lastPress < RESULT_COOLDOWN_MS) {
        return safeReply(event, { type: 'text', text: '當局牌局尚未結束，請當局牌局結束再做操作。' });
      }
      resultPressCooldown.set(userId, nowTs);

      const actual = parts[1];            // '莊' / '閒' / '和'（龍/虎）
      const fullTableName = parts[2];
      const last = userLastRecommend.get(userId);

      // 記帳
      if (last && last.fullTableName === fullTableName) {
        const cols = columnsFromAmount(last.amount) * (actual === last.side ? 1 : -1);
        const money = cols * 100;
        const entry = { ...last, actual, columns: cols, money, ts: Date.now() };
        const arr = userBetLogs.get(userId) || [];
        arr.push(entry);
        userBetLogs.set(userId, arr);
      }

      // 更新序列（龍=閒、虎=莊）
      const mapDT = { '龍':'閒', '虎':'莊' };
      const toAppend = mapDT[actual] || actual;

      let rec = userRecentInput.get(userId) || { seq:'', full:fullTableName, ts:nowTs };
      if (!rec.full || rec.full !== fullTableName) rec = { seq:'', full:fullTableName, ts:nowTs };
      let seqAfter = rec.seq + toAppend;
      if (seqAfter.length > 20) seqAfter = seqAfter.slice(-20);
      userRecentInput.set(userId, { seq:seqAfter, full:fullTableName, ts:nowTs });

      // 產生下一輪分析建議
      const partsFull = String(fullTableName).split('|');
      const systemName = partsFull[0] || fullTableName;
      const hallName   = partsFull[1] || '';
      const isDragonTiger = (hallName === '龍虎鬥');

      let mainPick;
      const r = Math.random() * 100;
      mainPick = isDragonTiger ? (r < 50 ? '龍' : '虎') : (r < 50 ? '莊' : '閒');
      const passRate  = Math.floor(Math.random() * (90 - 45 + 1)) + 45;
      let betLevel = '觀望', betAmount = 100;
      if      (passRate <= 50) { betLevel = '觀望'; betAmount = 100; }
      else if (passRate <= 65) { betLevel = '小注'; betAmount = randHundreds(100, 1000); }
      else if (passRate <= 75) { betLevel = '中注'; betAmount = randHundreds(1100, 2000); }
      else                     { betLevel = '重注'; betAmount = randHundreds(2100, 3000); }

      const reasons = [
        `近期節奏偏${mainPick}，勝率估約${passRate}% ，資金可採階梯式進場。`,
        `路紙單邊延伸、波動收斂，${mainPick}佔優；以風險報酬比評估，${betLevel}較合理。`,
        `連動段落未轉折，${mainPick}承接力強；量化指標偏多，依紀律${betLevel}。`,
        `慣性朝${mainPick}傾斜，優勢未被破壞；依趨勢邏輯，執行${betLevel}。`,
        `形態無反轉訊號，${mainPick}動能續航；配合分散下注原則，${betLevel}較佳。`,
      ];
      const reason = reasons[Math.floor(Math.random()*reasons.length)];

      // 更新「最後推薦」
      userLastRecommend.set(userId, {
        fullTableName, system: systemName, hall: hallName, table: partsFull[2] || '',
        side: mainPick, amount: betAmount, ts: Date.now()
      });

      // 回「合併卡」
      const combined = combinedBeadplateAndAnalysisFlex({
        seq: seqAfter,
        fullTableName,
        systemName,
        mainPick, betLevel, betAmount, passRate, reason,
        isDragonTiger
      });
      return safeReply(event, { type:'flex', altText:`當前珠盤 + 分析 - ${fullTableName}`, contents: combined });
    }
  }

  // 預設回覆
  return safeReply(event, { type: 'text', text: '已關閉問答模式，需要開啟請輸入關鍵字。' });
} // end handleEvent

/* =========================
 * 全域錯誤處理
 * ========================= */
process.on('unhandledRejection', (reason) => console.error('UnhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));
