require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const cron = require('node-cron');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const GROUP_ID = process.env.GROUP_ID;


mongoose.connect('mongodb+srv://admin:admin@cluster0.clzvh.mongodb.net/');

bot.setMyCommands([
    { command: '/sync_users', description: 'Синхронизировать участников' },
    { command: '/done', description: 'Подтвердить выполнение задачи' },
    { command: '/reset_tasks', description: 'Перераспределить задачи' },
    { command: '/status', description: 'Статус задач' },
    { command: '/points', description: 'Рейтинг пользователей' },
    { command: '/notify_out_of_stock', description: 'Сообщить о закончившейся вещи' },
    { command: '/check_stock', description: 'Показать, что в наличии, а что нет' },
    { command: '/mark_bought', description: 'Отметить, что вещь куплена' }
]);


// Схема пользователя
const UserSchema = new mongoose.Schema({
    userId: Number,
    name: String,
    points: { type: Number, default: 0 },
    previousTask: { type: String, default: null } // Храним последнюю задачу
});
const User = mongoose.model('User', UserSchema);

const ItemSchema = new mongoose.Schema({
    name: String,
    inStock: { type: Boolean, default: true },
    lastBoughtBy: { type: Number, default: null }
});
const Item = mongoose.model('Item', ItemSchema);


// Схема задач с добавлением сложности
const TaskSchema = new mongoose.Schema({
    name: String,
    assignedTo: Number,
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    completed: { type: Boolean, default: false }
});
const Task = mongoose.model('Task', TaskSchema);

const taskCreationState = new Map();

// Функция для автоматического определения участников группы
bot.onText(/\/sync_users/, async (msg) => {
    if (msg.from.first_name !== "глеб") {
        return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав на выполнение этой команды.');
    }    
    if (msg.chat.id !== Number(GROUP_ID)) return;

    try {
        const chatMembers = await bot.getChatAdministrators(GROUP_ID);
        let addedUsers = [];
        
        for (const member of chatMembers) {
            if (!member.user.is_bot) {
                await User.findOneAndUpdate(
                    { userId: member.user.id },
                    { name: member.user.first_name, previousTask: null },
                    { upsert: true }
                );
                addedUsers.push(member.user.first_name);
            }
        }
        
        const userList = addedUsers.length > 0 ? addedUsers.join(', ') : 'Нет новых участников';
        bot.sendMessage(GROUP_ID, `✅ Участники группы синхронизированы! Добавлены: ${userList}`);
    } catch (err) {
        console.error('Ошибка при получении участников группы:', err);
        bot.sendMessage(GROUP_ID, '❌ Ошибка при синхронизации участников.');
    }
});

// Функция назначения задач
async function assignTasks() {
    const users = await User.find();
    const tasks = await Task.find();
    if (users.length === 0 || tasks.length === 0) return;

    const assignedTaskNames = new Set(); // Сюда будем добавлять названия уже назначенных задач
    let assignedTasks = [];

    for (const user of users) {
        // Фильтруем задачи: исключаем предыдущую и уже назначенные в этом проходе
        let availableTasks = tasks.filter(task =>
            task.name !== user.previousTask && !assignedTaskNames.has(task.name)
        );

        // Если ничего не осталось — берём любую ещё не выданную (может совпадать с previousTask)
        if (availableTasks.length === 0) {
            availableTasks = tasks.filter(task => !assignedTaskNames.has(task.name));
        }

        // Если совсем нет доступных задач, пропускаем пользователя
        if (availableTasks.length === 0) {
            assignedTasks.push(`⚠️ Нет доступной задачи для ${user.name}`);
            continue;
        }

        const task = availableTasks[Math.floor(Math.random() * availableTasks.length)];

        await Task.findOneAndUpdate({ name: task.name }, { assignedTo: user.userId, completed: false });
        await User.findOneAndUpdate({ userId: user.userId }, { previousTask: task.name });

        assignedTaskNames.add(task.name); // Добавляем в список уже назначенных
        assignedTasks.push(`📌 ${task.name} – ${user.name}`);
    }

    bot.sendMessage(GROUP_ID, `📢 *Новые обязанности на неделю:*

${assignedTasks.join('\n')}`, { parse_mode: 'Markdown' });
}


// Автоматическое назначение задач по пятницам в 18:00
cron.schedule('0 18 * * 5', async () => {
    await assignTasks();
}, {
    timezone: "Europe/Kiev"
});

// Автообновление статуса задач в понедельник в 00:00
cron.schedule('0 0 * * 1', async () => {
    const overdueTasks = await Task.find({ completed: false });
    for (const task of overdueTasks) {
        await User.findOneAndUpdate({ userId: task.assignedTo }, { $inc: { points: -1 } });
    }
    await Task.updateMany({}, { completed: false, assignedTo: null });
    bot.sendMessage(GROUP_ID, '⏳ Все задачи сброшены, новая неделя началась!');
}, {
    timezone: "Europe/Kiev"
});

// 🕛 Сброс очков в 00:00 первого дня каждого месяца
cron.schedule('0 0 1 * *', async () => {
    try {
        await User.updateMany({}, { points: 0 });
        console.log('✅ Все очки сброшены до 0!');
        bot.sendMessage(GROUP_ID, '🔄 Новый месяц! Все очки сброшены до 0.');
    } catch (error) {
        console.error('❌ Ошибка при сбросе очков:', error);
    }
}, {
    timezone: "Europe/Kiev"
});

// Подтверждение выполнения задачи
bot.onText(/\/done/, async (msg) => {
    const userId = msg.from.id;
    const task = await Task.findOne({ assignedTo: userId, completed: false });
    if (!task) return bot.sendMessage(msg.chat.id, '❌ У вас нет незавершенных задач!');
    
    await Task.findOneAndUpdate({ assignedTo: userId, completed: false }, { completed: true });
    await User.findOneAndUpdate({ userId }, { $inc: { points: 1 } });
    bot.sendMessage(GROUP_ID, `✅ ${msg.from.first_name} выполнил задачу: *${task.name}*! (+1 балл)`, { parse_mode: 'Markdown' });
});

// Ручное перераспределение задач
bot.onText(/\/reset_tasks/, async (msg) => {
    if (msg.from.first_name !== "глеб") {
        return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав на выполнение этой команды.');
    }  
    await assignTasks();
    bot.sendMessage(GROUP_ID, '🔄 Задачи были сброшены и распределены заново!');
});

// Отображение статуса текущих задач
bot.onText(/\/status/, async (msg) => {
    const tasks = await Task.find();
    if (tasks.length === 0) return bot.sendMessage(msg.chat.id, '❌ Нет активных задач.');
    
    // Получаем всех пользователей, чтобы создать соответствие userId -> name
    const users = await User.find();
    const userMap = {};
    users.forEach(user => {
        userMap[user.userId] = user.name;
    });

    // Формируем список задач с именами пользователей
    const statusList = tasks.map(task => {
        const assignedName = userMap[task.assignedTo] || "❓ Неизвестный";
        return `📌 ${task.name} – ${task.completed ? '✅ Выполнено' : '❌ Не выполнено'} (👤 ${assignedName})`;
    }).join('\n');

    bot.sendMessage(GROUP_ID, `📋 *Статус задач:*\n\n${statusList}`, { parse_mode: 'Markdown' });
});

// Отображение текущих очков пользователей
bot.onText(/\/points/, async (msg) => {
    const users = await User.find().sort({ points: -1 });
    if (users.length === 0) return bot.sendMessage(msg.chat.id, '❌ Нет пользователей в системе.');
    
    const pointsList = users.map(user => `👤 ${user.name}: ${user.points} баллов`).join('\n');
    bot.sendMessage(GROUP_ID, `🏆 *Рейтинг пользователей:*\n\n${pointsList}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/notify_out_of_stock/, async (msg) => {
    const items = await Item.find({ inStock: true });
    if (!items.length) return bot.sendMessage(msg.chat.id, '✅ Все предметы в наличии.');

    const inlineKeyboard = items.map(item => {
        return [{ text: item.name, callback_data: `outofstock_${item._id}` }];
    });    

    bot.sendMessage(msg.chat.id, '🧼 Что закончилось?', {
        reply_markup: {
            inline_keyboard: inlineKeyboard
        }
    });
});

bot.onText(/\/check_stock/, async (msg) => {
    const items = await Item.find();
    const users = await User.find().sort({ userId: 1 });
    if (!users.length) return bot.sendMessage(msg.chat.id, '❌ Нет пользователей.');
    if (!items.length) return bot.sendMessage(msg.chat.id, '❌ Нет вещей.');

    const userMap = {};
    users.forEach(u => userMap[u.userId] = u.name);

    const inStockList = items
        .filter(item => item.inStock)
        .map(item => `✅ ${item.name} (последний покупал: ${userMap[item.lastBoughtBy] || '—'})`);

    const outOfStockList = items
        .filter(item => !item.inStock)
        .map(item => {
            const lastIndex = users.findIndex(u => u.userId === item.lastBoughtBy);
            const nextBuyer = lastIndex === -1 || lastIndex === users.length - 1
                ? users[0]
                : users[lastIndex + 1];
            return `❌ ${item.name} – должен купить: *${nextBuyer.name}*`;
        });

    const message = `📦 *Наличие вещей:*\n\n${inStockList.join('\n') || '—'}

🛒 *Нужно купить:*\n\n${outOfStockList.join('\n') || '—'}`;

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/mark_bought/, async (msg) => {
    const items = await Item.find({ inStock: false });
    if (!items.length) {
        return bot.sendMessage(msg.chat.id, '✅ Все вещи уже куплены!');
    }

    const keyboard = items.map(item => {
        return [{ text: item.name, callback_data: `markbought_${item._id}` }];
    });    

    bot.sendMessage(msg.chat.id, 'Что ты купил?', {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
});

bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;

    const users = await User.find().sort({ userId: 1 });
    if (!users.length) {
        return bot.sendMessage(chatId, '❌ Нет зарегистрированных пользователей.');
    }

    // ✅ Обработка кнопки "Вещь закончилась"
    if (data.startsWith('outofstock_')) {
        const itemId = data.replace('outofstock_', '');

        // Обновляем только если вещь ещё в наличии
        const item = await Item.findOneAndUpdate(
            { _id: itemId, inStock: true },
            { $set: { inStock: false } },
            { new: true }
        );

        if (!item) {
            return bot.answerCallbackQuery(query.id, { text: '❌ Уже обработано или предмет не найден.' });
        }

        // Определяем следующего покупателя по кругу
        const lastIndex = users.findIndex(u => u.userId === item.lastBoughtBy);
        const nextBuyer = lastIndex === -1 || lastIndex === users.length - 1
            ? users[0]
            : users[lastIndex + 1];

        item.lastBoughtBy = nextBuyer.userId;
        await item.save();

        try {
            await bot.deleteMessage(chatId, msgId);
        } catch (err) {
            console.warn('⚠️ Не удалось удалить сообщение с кнопками:', err.message);
        }

        await bot.sendMessage(GROUP_ID, `📢 *${item.name}* закончился!\n🛒 Купить должен: *${nextBuyer.name}*`, {
            parse_mode: 'Markdown'
        });

        return bot.answerCallbackQuery(query.id, { text: '✅ Отмечено как "не в наличии"' });
    }

    // ✅ Обработка кнопки "Я купил"
    if (data.startsWith('markbought_')) {
        const itemId = data.replace('markbought_', '');

        const item = await Item.findOneAndUpdate(
            { _id: itemId, inStock: false },
            { $set: { inStock: true } },
            { new: true }
        );

        if (!item) {
            return bot.answerCallbackQuery(query.id, { text: '❌ Уже куплено или не найдено.' });
        }

        try {
            await bot.deleteMessage(chatId, msgId);
        } catch (err) {
            console.warn('⚠️ Не удалось удалить сообщение с кнопками:', err.message);
        }

        await bot.sendMessage(GROUP_ID, `✅ ${query.from.first_name} купил *${item.name}*`, {
            parse_mode: 'Markdown'
        });

        return bot.answerCallbackQuery(query.id, { text: '✅ Отмечено как куплено' });
    }

    // 📛 Непонятное действие
    bot.answerCallbackQuery(query.id, { text: '🤷 Неизвестная кнопка' });
});



module.exports = bot;
