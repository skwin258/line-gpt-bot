const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();

// 只在 webhook 這個路由用 express.raw()，並用 LINE middleware 驗證簽章
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  line.middleware(config)(req, res, async (err) => {
    if (err) {
      console.error('Middleware error:', err);
      return res.status(401).send('Unauthorized');
    }

    // 解析事件
    const events = JSON.parse(req.body.toString()).events;
    const client = new line.Client(config);

    try {
      // 回覆所有訊息事件
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
