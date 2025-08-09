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

// 請放入你的 tableData 和各種 Flex Message 生成函式，內容保持不動...

const userLastActiveTime = new Map();   
const resultPressCooldown = new Map();  
const userRecentInput = new Map();      
const qaModeUntil = new Map();          

const INACTIVE_MS = 2 * 60 * 1000;
const RESULT_COOLDOWN_MS = 10 * 1000;
const QA_WINDOW_MS = 3 * 60 * 1000;

const app = express();

app.use(middleware(config));
app.use(express.json());

app.post('/webhook', (req, res) => {
  res.status(200).end();

  handleEvents(req.body.events).catch((err) => {
    console.error('事件處理錯誤:', err);
  });
});

async function replyBlankMessage(replyToken) {
  try {
    await client.replyMessage(replyToken, { type: 'text', text: ' ' });
  } catch (e) {
    console.error('空白訊息回覆失敗:', e);
  }
}

async function handleEvents(events) {
  const now = Date.now();

  await Promise.all(events.map(async (event) => {
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const userMessage = event.message.text.trim();

      // 若訊息是「聯絡客服」或「當月優惠」，回空白訊息避免官方補回感謝訊息
      if (userMessage === '聯絡客服' || userMessage === '當月優惠') {
        console.log(`跳過正常回覆，改回覆空白訊息，交由官方處理：${userMessage}`);
        await replyBlankMessage(event.replyToken);
        return;
      }

      // 其餘情況先回空白訊息防止官方回覆，之後再正常回覆你的內容
      await replyBlankMessage(event.replyToken);

      // 以下原本所有的條件與回覆邏輯完全照原本寫，僅把await client.replyMessage改成await client.replyMessage(…)即可正常回覆

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

      // 這裡不用再回空白訊息，因為所有訊息已回空白訊息（上面有先回）
      // 不回覆任何內容，官方不會再回覆感謝訊息了
      return;
    }
  }));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
