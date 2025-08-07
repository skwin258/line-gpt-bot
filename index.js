const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();

// 1. 先用 middleware 拿原始字串
app.post('/webhook', line.middleware(config), express.json(), async (req, res) => {
  try {
    // 2. express.json() 會在這裡幫你轉成物件了
    const events = req.body.events;
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
    res.status(500).end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
