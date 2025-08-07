const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();

// 只用一個 POST /webhook，並用 express.raw 解析 body
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // 先讓 line.middleware 做驗證，沒錯就執行下方事件處理
    await new Promise((resolve, reject) => {
      line.middleware(config)(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // 解析事件
    const events = JSON.parse(req.body.toString()).events;
    const client = new line.Client(config);

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
    if (error.statusCode) {
      res.status(error.statusCode).send(error.message);
    } else {
      res.status(500).end();
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
