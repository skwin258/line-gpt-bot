const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json()); // 🔧 這行很重要，必加！

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    const results = await Promise.all(events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const prompt = event.message.text;
  const replyToken = event.replyToken;

  try {
    const gptReply = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const replyText = gptReply.data.choices[0].message.content.trim();

    return client.replyMessage(replyToken, {
      type: 'text',
      text: replyText,
    });

  } catch (err) {
    console.error('GPT error:', err);
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '⚠️ 無法連接 GPT，請稍後再試。',
    });
  }
}

app.get('/', (req, res) => {
  res.send('LINE GPT bot is running.');
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
