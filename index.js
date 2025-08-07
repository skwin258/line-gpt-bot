const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();

// 只設定一個 /webhook POST 路由
app.post('/webhook', express.raw({ type: 'application/json' }), line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    const client = new line.Client(config);

    await Promise.all(events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        let replyText = `你說的是: ${event.message.text}`;
        if (event.message.text.trim() === '你好') {
          replyText = '哈囉！有什麼可以幫忙的嗎？';
        } else if (event.message.text.trim() === '幫助') {
          replyText = '你可以跟我聊NBA分析、電子遊戲訊號，或者說「開啟功能」來看指令';
        }

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: replyText,
        });
      }
    }));

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).end();
  }
});

// 這裡攔截所有未定義路由，回應 404 或其他訊息，避免錯誤干擾
app.use((req, res) => {
  res.status(404).send('Not found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
