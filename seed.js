require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect('mongodb+srv://admin:admin@cluster0.clzvh.mongodb.net/', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const User = mongoose.model('User', new mongoose.Schema({
  userId: Number,
  name: String,
  points: Number,
  previousTask: String
}));

const Item = mongoose.model('Item', new mongoose.Schema({
  name: String,
  inStock: { type: Boolean, default: true },
  buyerQueue: [Number],
  currentBuyerIndex: { type: Number, default: 0 }
}));

(async () => {
  const users = await User.find();
  if (users.length < 2) {
    console.log('❌ Нужно минимум 2 пользователя для очереди.');
    return process.exit();
  }

  const userIds = users.map(u => u.userId);

  const shuffle = (array) => [...array].sort(() => Math.random() - 0.5);

  const itemNames = [
    'Мыло',
    'Туалетная бумага',
    'Мочалки',
    'Моющее средство на кухню',
    'Моющее средство для ванны/туалета',
    'Перчатки',
    'Тряпки',
    'Мусорные пакеты'
  ];

  await Item.deleteMany({}); // Очистим старые записи

  for (const name of itemNames) {
    const queue = shuffle(userIds);
    const inStock = true;
    const currentBuyerIndex = Math.floor(Math.random() * queue.length);

    await Item.create({
      name,
      inStock,
      buyerQueue: queue,
      currentBuyerIndex: inStock ? (currentBuyerIndex + 1) % queue.length : currentBuyerIndex
    });
  }

  console.log('✅ База успешно заполнена предметами.');
  process.exit();
})();
