import express from 'express';
import { config } from 'dotenv';
import { createServer } from 'http';
import { middleware, Client } from '@line/bot-sdk';

// 載入 .env
config();

// 初始化 LINE 設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 建立 LINE 客戶端
const client = new Client(lineConfig);

// Express App
const app = express();

// 中介層處理 LINE 驗證用的簽章
app.use('/webhook', middleware(lineConfig));

// 處理 LINE 傳來的事件
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;
    // 回應每一個事件
    const results = await Promise.all(events.map(handleEvent));
    res.status(200).json(results);
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(500).end();
  }
});

// 處理事件的函式
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  // 回傳原本訊息
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `你剛剛說：「${event.message.text}」`
  });
}

// 啟動伺服器
const port = process.env.PORT || 3000;
createServer(app).listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
