const { Configuration, OpenAIApi } = require("openai");
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// 你的 /webhook 路由內的事件處理改成這樣：
app.post('/webhook', express.raw({ type: 'application/json' }), line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    const client = new line.Client(config);

    await Promise.all(events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        const userText = event.message.text.trim();

        let replyText = `你說的是: ${userText}`;

        // 百家樂分析示範
        if (userText.includes('百家分析') || userText.includes('百家樂分析')) {
          const prompt = `請幫我做一段專業的百家樂遊戲分析，給玩家下注建議，內容要詳盡且專業。`;
          try {
            const completion = await openai.createChatCompletion({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: prompt }],
              max_tokens: 500,
            });
            replyText = completion.data.choices[0].message.content.trim();
          } catch (err) {
            console.error('OpenAI API error:', err);
            replyText = '抱歉，百家樂分析服務暫時不可用。';
          }
        }

        // 其他指令可以在這裡繼續擴展...

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
