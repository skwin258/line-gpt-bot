const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();

// 只用一個 webhook 路由，express.raw 解析原始 body
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // 使用 LINE middleware 驗證簽章
  line.middleware(config)(req, res, async (err) => {
    if (err) {
      console.error('Middleware error:', err);
      return res.status(401).send('Unauthorized');
    }

    // 取得事件
    const events = JSON.parse(req.body.toString()).events;
    const client = new line.Client(config);

    try {
      // 處理每個事件
      await Promise.all(events.map(async (event) => {
        if (event.type === 'message' && event.message.type === 'text') {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `你說的是: ${event.message.text}`,
          });
        }
      }));
      res.status(200).send('OK');
    } catch (error) {
      console.error('Webhook handler error:', error);
      res.status(500).end();
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
