const crypto = require('crypto');
const fs = require('fs');

// Генерация 32-байтового ключа в hex-формате (64 символа)
const encryptionKey = crypto.randomBytes(32).toString('hex');

// Сохранение ключа в .env файл
fs.writeFileSync('.env', `ENCRYPTION_KEY=${encryptionKey}\n`, { flag: 'w' });
console.log('Ключ шифрования сгенерирован и сохранен в .env файл.');
