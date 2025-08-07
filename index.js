require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// LINE config
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// Webhook route
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

// 處理 LINE 使用者訊息
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = event.message.text;
  const replyToken = event.replyToken;

  try {
    const gptReply = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: userText }],
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
  } catch (error) {
    console.error('GPT Error:', error.message);
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '⚠️ 抱歉，AI 回覆時發生錯誤，請稍後再試。',
    });
  }
}

// 健康檢查
app.get('/', (req, res) => {
  res.send('🤖 LINE GPT bot is running.');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
