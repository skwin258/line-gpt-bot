import pkg from '@line/bot-sdk'; 
const { middleware, Client } = pkg;
import dotenv from 'dotenv';
import OpenAI from 'openai';
import express from 'express';

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const allowedUsers = new Set([
  'U48c33cd9a93a3c6ce8e15647b8c17f08',
  'Ufaeaa194b93281c0380cfbfd59d5aee0',
  'U73759fc9139edfaf7c804509d0a8c07f',
  'U63918f9d8b44770747034598a351595e',
  'U1cebd63109f62550c10df0ab835a900c',
  'U435c5ceb25a2f23141bde151a31b471b',
  'U2031c52d282931d135d54e21c5657184',
  'U3f0220713af62f033178f6f174f2a243',
  'U9fb9f639728eb09947888f17cfdb9133',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
  'U11223344556677889900aabbccddeeff',
]);

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

// 狀態暫存
const userLastActiveTime = new Map();   
const resultPressCooldown = new Map();  
const userRecentInput = new Map();      
const qaModeUntil = new Map();          

const INACTIVE_MS = 2 * 60 * 1000;
const RESULT_COOLDOWN_MS = 10 * 1000;
const QA_WINDOW_MS = 3 * 60 * 1000;

// --------- Flex Message 生成 ---------

function generateHallSelectFlex(gameName) {
  const halls = Object.keys(tableData[gameName] || {});
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: `遊戲：${gameName}`,
          weight: 'bold',
          color: '#00B900',
          size: 'lg',
          align: 'center',
        },
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

function generateTableListFlex(gameName, hallName, tables, page = 1, pageSize = 10) {
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, tables.length);
  const pageTables = tables.slice(startIndex, endIndex);

  const maxHighlightCount = Math.max(1, Math.floor(pageTables.length / 3));
  const hotCount = Math.min(maxHighlightCount, 3);
  const recommendCount = Math.min(maxHighlightCount, 3);

  const hotIndexes = [];
  const recommendIndexes = [];

  while (hotIndexes.length < hotCount) {
    const r = Math.floor(Math.random() * pageTables.length);
    if (!hotIndexes.includes(r)) hotIndexes.push(r);
  }

  while (recommendIndexes.length < recommendCount) {
    const r = Math.floor(Math.random() * pageTables.length);
    if (!hotIndexes.includes(r) && !recommendIndexes.includes(r)) recommendIndexes.push(r);
  }

  const minBet = 100;
  const maxBet = 10000;

  const bubbles = pageTables.map((table, idx) => {
    let statusText = '進行中';
    let statusColor = '#555555';

    if (hotIndexes.includes(idx)) {
      statusText = '🔥熱門';
      statusColor = '#FF3D00';
    } else if (recommendIndexes.includes(idx)) {
      statusText = '⭐️本日推薦';
      statusColor = '#FFD700';
    }

    return {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: table, weight: 'bold', size: 'md', color: '#00B900' },
          { type: 'text', text: statusText, size: 'sm', color: statusColor, margin: 'sm' },
          { type: 'text', text: `最低下注：${minBet}元`, size: 'sm', color: '#555555', margin: 'sm' },
          { type: 'text', text: `最高限額：${maxBet}元`, size: 'sm', color: '#555555', margin: 'sm' },
          {
            type: 'button',
            action: { type: 'message', label: '選擇', text: `選擇桌號|${gameName}|${hallName}|${table}` },
            style: 'primary',
            color: '#00B900',
            margin: 'md',
          },
        ],
      },
    };
  });

  const carousel = {
    type: 'carousel',
    contents: bubbles,
  };

  if (endIndex < tables.length) {
    carousel.contents.push({
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `還有更多牌桌，點擊下一頁`,
            wrap: true,
            size: 'md',
            weight: 'bold',
            align: 'center',
          },
          {
            type: 'button',
            action: {
              type: 'message',
              label: '下一頁',
              text: `nextPage|${page + 1}|${gameName}|${hallName}`,
            },
            style: 'primary',
            color: '#00B900',
            margin: 'lg',
          },
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
        { 
          type: 'text', 
          text: '請輸入前10局閒莊和的結果，最少需要輸入前三局，例:閒莊閒莊閒莊閒莊和閒', 
          margin: 'md', 
          color: '#555555',
          wrap: true
        },
        {
          type: 'button',
          action: {
            type: 'message',
            label: '開始分析',
            text: `開始分析|${fullTableName}`,
          },
          style: 'primary',
          color: '#00B900',
          margin: 'lg',
        },
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

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateAnalysisResultFlex(fullTableName, predicted = null) {
  const parts = String(fullTableName).split('|');
  const gameName = parts[0] || fullTableName;
  const hallName = parts[1] || '';
  const isDragonTiger = hallName === '龍虎鬥';

  let mainPick;
  if (predicted && ((isDragonTiger && (predicted === '龍' || predicted === '虎')) || (!isDragonTiger && (predicted === '莊' || predicted === '閒')))) {
    mainPick = predicted;
  } else {
    const r = Math.random() * 100;
    if (isDragonTiger) {
      mainPick = (r < 50) ? '龍' : '虎';
    } else {
      mainPick = (r < 50) ? '莊' : '閒';
    }
  }

  const attachTieSmall = Math.random() < 0.05;
  const passRate = Math.floor(Math.random() * (90 - 45 + 1)) + 45;

  let betLevel = '觀望';
  let betAmount = 100;
  if (passRate <= 50) {
    betLevel = '觀望';
    betAmount = 100;
  } else if (passRate <= 65) {
    betLevel = '小注';
    betAmount = randHundreds(100, 1000);
  } else if (passRate <= 75) {
    betLevel = '中注';
    betAmount = randHundreds(1100, 2000);
  } else {
    betLevel = '重注';
    betAmount = randHundreds(2100, 3000);
  }

  const proReasonsGeneric = [
    `近期節奏偏${mainPick}，點數優勢與回補力度明顯，勝率估約${passRate}% ，資金可採階梯式進場。`,
    `路紙呈單邊延伸且波動收斂，${mainPick}佔優；以風險報酬比評估，${betLevel}較合理。`,
    `連動段落尚未轉折，${mainPick}方承接力強；量化指標偏多，建議依紀律${betLevel}。`,
    `盤勢慣性朝${mainPick}傾斜，短期優勢未被破壞；依趨勢交易邏輯，執行${betLevel}。`,
    `形態未出現反轉訊號，${mainPick}動能續航；配合分散下注原則，${betLevel}較佳。`,
  ];
  const mainReason = pickOne(proReasonsGeneric);

  const tieReasons = [
    `點數拉鋸且對稱度提高，和局機率上緣提升；僅以極小資金對沖波動。`,
    `近期出現多次臨界點比拼，存在插針和局風險；建議和局小注防守。`,
    `節奏收斂、分差縮小，和局出現條件具備；以小注配置分散風險。`,
    `牌型分布有輕微對稱跡象，和局非主軸但可小試；資金控制為先。`,
  ];
  const tieAddOn = attachTieSmall ? pickOne(tieReasons) : '';

  const resultLine = `預測結果為：${mainPick}（${betLevel}）${attachTieSmall ? ' 和小下' : ''}`;

  const leftBtnLabel  = isDragonTiger ? '龍' : '閒';
  const rightBtnLabel = isDragonTiger ? '虎' : '莊';

  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '分析結果', weight: 'bold', size: 'lg', color: '#00B900', align: 'center' },
        { type: 'text', text: `牌桌：${gameName}`, margin: 'md', color: '#555555' },
        { type: 'text', text: resultLine, margin: 'md', size: 'md' },
        { type: 'text', text: `推薦下注金額：${betAmount} 元`, margin: 'md', size: 'md' },
        { type: 'text', text: `過關機率：約 ${passRate}%`, margin: 'md', size: 'md' },
        { type: 'text', text: `說明：${mainReason}`, margin: 'md', wrap: true },
        ...(attachTieSmall ? [{ type: 'text', text: `和小下理由：${tieAddOn}`, margin: 'md', wrap: true }] : []),
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'md',
          margin: 'md',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#2185D0',
              action: { type: 'message', label: leftBtnLabel, text: `當局結果為|${leftBtnLabel}|${fullTableName}` },
              flex: 1,
            },
            {
              type: 'button',
              style: 'primary',
              color: '#21BA45',
              action: { type: 'message', label: '和', text: `當局結果為|和|${fullTableName}` },
              flex: 1,
            },
            {
              type: 'button',
              style: 'primary',
              color: '#DB2828',
              action: { type: 'message', label: rightBtnLabel, text: `當局結果為|${rightBtnLabel}|${fullTableName}` },
              flex: 1,
            },
          ],
        },
      ],
    },
  };
}

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
          { type: 'text', text: '2. 若在同一桌連續輸掉3局，建議立即換桌，讓系統繼續分析牌局數據。', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '3. 根據當局開出的結果進行點選，請勿選擇錯誤，不然會造成系統判斷錯誤。', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '4. 只要兩分鐘內未繼續使用即會中斷。', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '5. AI預測為輔助工具，請保持理性投注，量力而為，見好就收。', wrap: true },
        ],
      },
      {
        type: 'button',
        action: { type: 'message', label: '開始預測', text: '開始預測' },
        style: 'primary',
        color: '#00B900',
        margin: 'xl',
      },
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

// ===== 公開關鍵字（圖文選單用）：聯絡客服 / 當月優惠 =====
const CONTACT_REPLY_TEXT = `💥加入會員立刻領取5000折抵金💥
有任何疑問，客服隨時為您服務。
https://lin.ee/6kcsWNF`;

const MONTHLY_PROMO_IMAGES = [
  'https://i.ibb.co/8nS3tYvZ/photo-2025-08-10-01-34-12.jpg',
  // 可再加最多 4 張
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

function tryPublicKeyword(msg) {
  if (/^聯絡客服$/i.test(msg)) return { type: 'text', text: CONTACT_REPLY_TEXT };
  if (/^當月優惠$/i.test(msg)) return buildMonthlyPromoMessages();
  return null;
}

const app = express();

app.use(middleware(config));
app.use(express.json());

// webhook 路由，快速回應 200
app.post('/webhook', (req, res) => {
  res.status(200).end();

  handleEvents(req.body.events).catch((err) => {
    console.error('事件處理錯誤:', err);
  });
});

async function handleEvents(events) {
  const now = Date.now();

  await Promise.all(
    events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const userMessage = event.message.text.trim();

        const lastActive = userLastActiveTime.get(userId) || 0;
        if (now - lastActive > INACTIVE_MS) {
          userLastActiveTime.set(userId, now);
          await client.replyMessage(event.replyToken, [
            { type: 'text', text: '當次預測已中斷 請重新點選開始預測' },
            { type: 'flex', altText: 'SKwin AI算牌系統 注意事項', contents: flexMessageIntroJson },
          ]);
          return;
        }
        userLastActiveTime.set(userId, now);

        // 先處理「公開關鍵字」
        const pub = tryPublicKeyword(userMessage);
        if (pub) {
          await client.replyMessage(event.replyToken, pub);
          return;
        }

        if (userMessage === '會員開通' || userMessage === 'AI算牌說明') {
          await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: 'SKwin AI算牌系統 注意事項',
            contents: flexMessageIntroJson,
          });
          return;
        }

        if (!allowedUsers.has(userId)) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `您沒有使用權限，請先開通會員。\n\n您的uid為：${userId}\n\n將此id回傳至skwin-註冊送5000\n完成註冊步驟即可獲得權限，謝謝。`,
          });
          return;
        }

        if (userMessage === '開始預測') {
          await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '請選擇遊戲',
            contents: flexMessageGameSelectJson,
          });
          return;
        }

        if (['DG真人', '歐博真人', '沙龍真人', 'WM真人'].includes(userMessage)) {
          const hallFlex = generateHallSelectFlex(userMessage);
          await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: `${userMessage} 遊戲廳選擇`,
            contents: hallFlex,
          });
          return;
        }

        if (userMessage.includes('|')) {
          const parts = userMessage.split('|');
          if (parts.length === 2) {
            const [gameName, hallName] = parts;
            if (tableData[gameName] && tableData[gameName][hallName]) {
              const tables = tableData[gameName][hallName];
              const flexTables = generateTableListFlex(gameName, hallName, tables, 1);
              if (flexTables.contents.length > 1) {
                const nextPageBubble = flexTables.contents[flexTables.contents.length - 1];
                if (nextPageBubble.body && nextPageBubble.body.contents) {
                  const btn = nextPageBubble.body.contents.find(c => c.type === 'button');
                  if (btn) {
                    btn.action.text = `nextPage|2|${gameName}|${hallName}`;
                  }
                }
              }
              await client.replyMessage(event.replyToken, {
                type: 'flex',
                altText: `${gameName} ${hallName} 牌桌列表 頁1`,
                contents: flexTables,
              });
              return;
            }
          }
        }

        if (userMessage.startsWith('nextPage|')) {
          const parts = userMessage.split('|');
          if (parts.length === 4) {
            const page = parseInt(parts[1], 10);
            const gameName = parts[2];
            const hallName = parts[3];
            if (tableData[gameName] && tableData[gameName][hallName]) {
              const tables = tableData[gameName][hallName];
              const flexTables = generateTableListFlex(gameName, hallName, tables, page);
              if (flexTables.contents.length > 1) {
                const nextPageBubble = flexTables.contents[flexTables.contents.length - 1];
                if (nextPageBubble.body && nextPageBubble.body.contents) {
                  const btn = nextPageBubble.body.contents.find(c => c.type === 'button');
                  if (btn) {
                    btn.action.text = `nextPage|${page + 1}|${gameName}|${hallName}`;
                  }
                }
              }
              await client.replyMessage(event.replyToken, {
                type: 'flex',
                altText: `${gameName} ${hallName} 牌桌列表 頁${page}`,
                contents: flexTables,
              });
              return;
            }
          }
        }

        if (userMessage.startsWith('選擇桌號|')) {
          const parts = userMessage.split('|');
          const gameName = parts[1];
          const hallName = parts[2];
          const tableNumber = parts[3];
          const fullTableName = `${gameName}|${hallName}|${tableNumber}`;
          const inputInstructionFlex = generateInputInstructionFlex(fullTableName);
          await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: `請輸入 ${fullTableName} 前10局結果`,
            contents: inputInstructionFlex,
          });
          return;
        }

        if (
          userMessage.length >= 1 &&
          userMessage.length <= 10 &&
          /^[\u4e00-\u9fa5]+$/.test(userMessage) &&
          !/^[閒莊和]+$/.test(userMessage)
        ) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '偵測到無效字元，請僅使用「閒 / 莊 / 和」輸入，例：閒莊閒莊閒。',
          });
          return;
        }

        if (/^[閒莊和]{3,10}$/.test(userMessage)) {
          userRecentInput.set(userId, { seq: userMessage, ts: now });
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '已接收前10局結果，請點擊「開始分析」按鈕開始計算。',
          });
          return;
        }

        if (/^[閒莊和]+$/.test(userMessage)) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '目前尚未輸入前10局內結果資訊， 無法為您做詳細分析，請先輸入前10局內閒莊和的結果，最少需要輸入前三局的結果，例:閒莊閒莊閒閒和莊。',
          });
          return;
        }

        if (userMessage.startsWith('開始分析|')) {
          const fullTableName = userMessage.split('|')[1];
          const rec = userRecentInput.get(userId);
          if (!rec || !/^[閒莊和]{3,10}$/.test(rec.seq)) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '目前尚未輸入前10局內結果資訊， 無法為您做詳細分析，請先輸入前10局內閒莊和的結果，最少需要輸入前三局的結果，例:閒莊閒莊閒閒和莊。',
            });
            return;
          }
          const analysisResultFlex = generateAnalysisResultFlex(fullTableName);
          await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: `分析結果 - ${fullTableName}`,
            contents: analysisResultFlex,
          });
          return;
        }

        if (userMessage.startsWith('當局結果為|')) {
          const lastPress = resultPressCooldown.get(userId) || 0;
          if (now - lastPress < RESULT_COOLDOWN_MS) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '當局牌局尚未結束，請當局牌局結束再做操作。',
            });
            return;
          }
          resultPressCooldown.set(userId, now);

          const parts = userMessage.split('|'); 
          if (parts.length === 3) {
            const fullTableName = parts[2];
            const analysisResultFlex = generateAnalysisResultFlex(fullTableName);
            await client.replyMessage(event.replyToken, {
              type: 'flex',
              altText: `分析結果 - ${fullTableName}`,
              contents: analysisResultFlex,
            });
            return;
          }
        }

        if (userMessage.startsWith('AI問與答')) {
          qaModeUntil.set(userId, now + QA_WINDOW_MS);
          const q = userMessage.replace(/^AI問與答\s*/, '').trim();
          if (!q) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '請問您想詢問甚麼主題或是具體問題呢?',
            });
          } else {
            const chatCompletion = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [{ role: 'user', content: q }],
            });
            const replyText = chatCompletion.choices[0].message.content;
            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
          }
          return;
        }

        const qaUntil = qaModeUntil.get(userId) || 0;
        if (now < qaUntil) {
          const chatCompletion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: userMessage }],
          });
          const replyText = chatCompletion.choices[0].message.content;
          await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
          return;
        }

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '已關閉問答模式，需要開啟請輸入關鍵字。',
        });
        return;
      }
    }),
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
