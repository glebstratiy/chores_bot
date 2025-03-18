require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const cron = require('node-cron');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const GROUP_ID = process.env.GROUP_ID;


mongoose.connect('mongodb+srv://admin:admin@cluster0.clzvh.mongodb.net/');

// Схема пользователя
const UserSchema = new mongoose.Schema({
    userId: Number,
    name: String,
    points: { type: Number, default: 0 },
    previousTask: { type: String, default: null } // Храним последнюю задачу
});
const User = mongoose.model('User', UserSchema);

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

// Добавление задачи
bot.onText(/\/add_task/, (msg) => {
    if (msg.from.first_name !== "глеб") {
        return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав на выполнение этой команды.');
    }  
    taskCreationState.set(msg.from.id, { step: 1 });
    bot.sendMessage(msg.chat.id, '📝 Введите название задачи:');
});

// Обработка сообщений для ввода названия задачи
bot.on('message', async (msg) => {
    const userState = taskCreationState.get(msg.from.id);
    if (!userState) return;

    if (userState.step === 1) {
        userState.taskName = msg.text;
        userState.step = 2;
        bot.sendMessage(msg.chat.id, '📌 Выберите сложность:', {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🟢 Легко', callback_data: 'easy' },
                        { text: '🟠 Средне', callback_data: 'medium' },
                        { text: '🔴 Сложно', callback_data: 'hard' }
                    ]
                ]
            }
        });
    }
});

// Обработка выбора сложности
bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id;
    const userState = taskCreationState.get(userId);
    if (!userState || userState.step !== 2) return;

    const difficulty = callbackQuery.data;
    const taskName = userState.taskName;

    await Task.create({ name: taskName, difficulty });
    bot.sendMessage(GROUP_ID, `✅ Задача "${taskName}" добавлена с уровнем сложности "${difficulty}"!`);
    taskCreationState.delete(userId);
});

// Удаление задачи с выбором из списка
bot.onText(/\/delete_task/, async (msg) => {
    if (msg.from.first_name !== "глеб") {
        return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав на выполнение этой команды.');
    }  
    const tasks = await Task.find();
    if (tasks.length === 0) return bot.sendMessage(msg.chat.id, '❌ Нет доступных задач для удаления.');

    const keyboard = tasks.map(task => [{ text: task.name, callback_data: `delete_${task.name}` }]);
    bot.sendMessage(msg.chat.id, '🗑 Выберите задачу для удаления:', {
        reply_markup: { inline_keyboard: keyboard }
    });
});

bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.data.startsWith('delete_')) {
        const taskName = callbackQuery.data.replace('delete_', '');
        await Task.findOneAndDelete({ name: taskName });
        bot.sendMessage(GROUP_ID, `✅ Задача "${taskName}" удалена!`);
    }
});

// Изменение задачи с выбором из списка
bot.onText(/\/edit_task/, async (msg) => {
    if (msg.from.first_name !== "глеб") {
        return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав на выполнение этой команды.');
    }  
    const tasks = await Task.find();
    if (tasks.length === 0) return bot.sendMessage(msg.chat.id, '❌ Нет доступных задач для редактирования.');

    const keyboard = tasks.map(task => [{ text: task.name, callback_data: `edit_${task.name}` }]);
    bot.sendMessage(msg.chat.id, '✏️ Выберите задачу для редактирования:', {
        reply_markup: { inline_keyboard: keyboard }
    });
});

bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.data.startsWith('edit_')) {
        const taskName = callbackQuery.data.replace('edit_', '');
        bot.sendMessage(callbackQuery.message.chat.id, `🔧 Выберите новую сложность для "${taskName}":`, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🟢 Легко', callback_data: `set_easy_${taskName}` },
                        { text: '🟠 Средне', callback_data: `set_medium_${taskName}` },
                        { text: '🔴 Сложно', callback_data: `set_hard_${taskName}` }
                    ]
                ]
            }
        });
    }
});

bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.data.startsWith('set_')) {
        const [_, difficulty, taskName] = callbackQuery.data.split('_');
        await Task.findOneAndUpdate({ name: taskName }, { difficulty });
        bot.sendMessage(GROUP_ID, `✅ Сложность задачи "${taskName}" изменена на "${difficulty}"!`);
    }
});

// Функция назначения задач
async function assignTasks() {
    const users = await User.find();
    const tasks = await Task.find();
    if (users.length === 0 || tasks.length === 0) return;

    let assignedTasks = [];
    for (const user of users) {
        // Исключаем последнюю назначенную задачу
        let availableTasks = tasks.filter(task => task.name !== user.previousTask);
        if (availableTasks.length === 0) availableTasks = tasks; // Если нет новых задач, даем любую

        const task = availableTasks[Math.floor(Math.random() * availableTasks.length)];
        await Task.findOneAndUpdate({ name: task.name }, { assignedTo: user.userId, completed: false });

        // Обновляем поле previousTask
        await User.findOneAndUpdate({ userId: user.userId }, { previousTask: task.name });
        
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

module.exports = bot;
