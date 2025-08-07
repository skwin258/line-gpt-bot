const express = require('express');
const line = require('@line/bot-sdk');
require('dotenv').config(); // 載入 .env

const app = express();

// LINE 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// webhook handler function
function handleEvent(event) {
  // 你自己的處理邏輯
  return Promise.resolve(null);
}

// 🔽 把這段加在這裡
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 🔽 這段放在最後（不要寫錯 port）
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
