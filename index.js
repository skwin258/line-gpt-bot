import express from 'express';
import line from '@line/bot-sdk';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }), line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    const client = new line.Client(config);

    await Promise.all(events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        const userText = event.message.text.trim();

        let replyText = `你說的是: ${userText}`;

        if (userText.includes('百家分析') || userText.includes('百家樂分析')) {
          const prompt = `請幫我做一段專業的百家樂遊戲分析，給玩家下注建議，內容要詳盡且專業。`;
          try {
            const completion = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: prompt }],
              max_tokens: 500,
            });
            replyText = completion.choices[0].message.content.trim();
          } catch (err) {
            console.error('OpenAI API error:', err);
            replyText = '抱歉，百家樂分析服務暫時不可用。';
          }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
