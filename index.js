require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

console.log('Channel Secret:', config.channelSecret);
console.log('Channel Access Token:', config.channelAccessToken);

const app = express();
app.use(express.json());

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
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
    console.error(error);
    res.status(500).end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
