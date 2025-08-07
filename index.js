const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();

app.use(express.json());

app.get('/webhook', (req, res) => {
  res.send('Webhook is live');
});

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }
  const client = new line.Client(config);
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `你說的是: ${event.message.text}`,
  });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
