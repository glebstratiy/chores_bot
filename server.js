require('dotenv').config();
const express = require('express');
const bot = require('./bot'); // Подключаем бота из bot.js

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const WEBHOOK_URL = `${WEBHOOK_DOMAIN}/bot${process.env.BOT_TOKEN}`;

bot.setWebHook(WEBHOOK_URL); // Устанавливаем Webhook

app.use(express.json());

// Обрабатываем запросы от Telegram
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Проверка, что сервер работает
app.get('/', (req, res) => {
    res.send('🤖 Бот работает через Webhook!');
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
