app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    console.log('X-Line-Signature:', req.headers['x-line-signature']);
    line.middleware(config)(req, res, (err) => {
      if (err) {
        console.error('Middleware error:', err);
        return res.status(401).send('Unauthorized');
      }

      const events = JSON.parse(req.body.toString()).events;
      const client = new line.Client(config);

      Promise.all(events.map(async (event) => {
        if (event.type === 'message' && event.message.type === 'text') {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `你說的是: ${event.message.text}`,
          });
        }
      })).then(() => {
        res.status(200).send('OK');
      }).catch((err) => {
        console.error('Error in event handler:', err);
        res.status(500).end();
      });
    });
  } catch (error) {
    console.error('Catch error:', error);
    res.status(500).end();
  }
});
