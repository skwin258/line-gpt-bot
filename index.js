require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
app.use(express.json());

app.post('/webhook', line.middleware(config), async (req, res) => {
  console.log('Webhook request body:', JSON.stringify(req.body, null, 2)); // 加入這行印出收到的資料
  try {
    const events = req.body.events || [];
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
