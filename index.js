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
  'Ufedcba0987654321fedcba0987654321',
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

const userLastActiveTime = new Map();   // userId -> timestamp(ms)
const resultPressCooldown = new Map();  // userId -> timestamp(ms)
const userRecentInput = new Map();      // userId -> { seq: string, ts: number }
const qaModeUntil = new Map();          // userId -> timestamp(ms)

const INACTIVE_MS = 2 * 60 * 1000;
const RESULT_COOLDOWN_MS = 10 * 1000;
const QA_WINDOW_MS = 3 * 60 * 1000;

// 你的各種 generateXXXFlex() 函式與工具函式
// （請照你原本的全部帶進來，不用漏掉）

const app = express();

app.use(middleware(config));
app.use(express.json());

app.post('/webhook', (req, res) => {
  // 立刻快速回應 LINE，避免 webhook 超時
  res.status(200).end();

  // 非同步事件處理
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

          const parts = userMessage.split('|'); // 當局結果為|<結果>|<桌號>
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
