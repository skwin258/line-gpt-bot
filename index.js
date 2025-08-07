const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
app.use(express.json());

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        const client = new line.Client(config);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `你說的是: ${event.message.text}`,
        });
      }
      return null;
    }));
    res.status(200).json(results);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
