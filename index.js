const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// 這行一定要加，讓 LINE 傳來的 JSON 能被解析
app.use(express.json());

// Webhook 路由
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error('Webhook Error:', err);
      res.status(500).end();
    });
});

// 回覆邏輯
function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const reply = {
    type: 'text',
    text: `你說的是：「${event.message.text}」`,
  };

  return client.replyMessage(event.replyToken, reply);
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
