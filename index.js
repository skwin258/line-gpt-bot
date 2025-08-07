app.post('/webhook', express.raw({ type: 'application/json' }), line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    const client = new line.Client(config);

    await Promise.all(events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        const userText = event.message.text.trim();

        let replyText = `你說的是: ${userText}`;

        if (userText === '你好') {
          replyText = '哈囉！有什麼可以幫忙的嗎？';
        } else if (userText === '幫助') {
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
