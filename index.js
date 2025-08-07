const express = require('express');
const line = require('@line/bot-sdk');

// 讀取環境變數（Railway 會自動注入 process.env）
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 建立 Line Bot 客戶端
const client = new line.Client(config);

// 建立 express 應用
const app = express();

// 處理 webhook 路由
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook Error:', err);
      res.status(500).end();
    });
});

// 處理每個事件的邏輯
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const replyText = `你說的是：「${event.message.text}」`;

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText
  });
}

// 啟動伺服器（Railway 用的 PORT）
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
