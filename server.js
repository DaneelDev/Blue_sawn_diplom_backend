const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bodyParser = require("body-parser");
require("dotenv").config();
const nodemailer = require("nodemailer");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001; // Порт, на котором будет работать сервер

app.use(cors());
app.use(bodyParser.json());

// Создание пула соединений с PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "Blue_swan",
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

// Блок для получения списка продуктов
app.get("/products", async (req, res) => {
  const { category, _sort, _order } = req.query;

  try {
    let query = "SELECT * FROM products";
    const values = [];

    // Добавление фильтра по категории
    if (category) {
      query += " WHERE category = \$1";
      values.push(category);
    }

    // Добавление сортировки
    if (_sort) {
      const allowedSort = ["name", "price", "created_at", "id"];
      const sortColumn = allowedSort.includes(_sort) ? _sort : "id";
      query += ` ORDER BY ${sortColumn} ${_order === "asc" ? "ASC" : "DESC"}`;
    }

    const result = await pool.query(query, values);
    res.json(result.rows); // Отправляем данные обратно на фронтенд
  } catch (error) {
    console.error("Ошибка при получении продуктов:", error);
    res.status(500).send("Ошибка сервера");
  }
});

//Блок создания заказа
// Функция для шифрования текста с использованием ключа
function encrypt(text, key) {
  const iv = crypto.randomBytes(12); // Генерация случайного вектора инициализации (IV)
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    iv,
  ); // Создание шифра

  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]); // Шифрование текста
  const tag = cipher.getAuthTag(); // Получение аутентификационного тега

  // Возвращаем результат в формате: iv + tag + encrypted
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

// Получаем ключ из переменной окружения
const keyBuffer = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
// Блок для создания заказа
app.post("/orders", async (req, res) => {
  const {
    recipientName,
    recipientPhone,
    recipientAddress,
    products,
    totalQuantity,
    totalPrice,
  } = req.body;

  try {
    // Шифруем поля перед вставкой в базу данных
    const encryptedName = encrypt(recipientName, keyBuffer);
    const encryptedPhone = encrypt(recipientPhone, keyBuffer);
    const encryptedAddress = encrypt(recipientAddress, keyBuffer);
    const jsonProducts = JSON.stringify(products); // Продукты храним в виде JSON без шифрования

    const query = `
      INSERT INTO orders (recipient_name, recipient_phone, recipient_address, products, total_quantity, total_price)
      VALUES (\$1, \$2, \$3, \$4, \$5, \$6) RETURNING *;
    `;

    const values = [
      encryptedName,
      encryptedPhone,
      encryptedAddress,
      jsonProducts,
      totalQuantity,
      totalPrice,
    ];

    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]); // Возвращаем созданный заказ
  } catch (error) {
    console.error("Ошибка при вставке заказа:", error);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// Настройка транспортера для Яндекс.Почты
const transporter = nodemailer.createTransport({
  host: "smtp.yandex.ru", // SMTP-сервер Яндекс
  port: 465, // Порт для SSL
  secure: true, // Использовать SSL
  auth: {
    user: process.env.SMTP_USER, // email на Яндекс
    pass: process.env.SMTP_PASS, // Пароль (или пароль приложения)
  },
});

// Отправка кода подтверждения
app.post("/send-email", async (req, res) => {
  const { email } = req.body;

  // Рандомлю случайный 6-значный код
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // Сохраняю код в базе данных
    await pool.query(
      "INSERT INTO verification_codes (email, verification_code) VALUES (\$1, \$2)",
      [email, code],
    );

    // Настройка параметров письма
    const mailOptions = {
      from: process.env.SMTP_USER, // email на Яндекс
      to: email, // Получатель
      subject: "Ваш код подтверждения",
      html: `<h1>Ваш код подтверждения: ${code}</h1>`, // HTML-содержимое
    };

    // Отправка email
    await transporter.sendMail(mailOptions);
    console.log(`Код ${code} отправлен на email ${email}`);

    // Отправление ответа
    res.status(200).json({ message: "Код отправлен на ваш email" });
  } catch (error) {
    console.error("Ошибка при отправке email:", error);
    res.status(500).json({ message: "Ошибка при отправке кода" });
  }
});

// Проверка кода
app.post("/verify-code", async (req, res) => {
  const { email, code } = req.body;

  try {
    // Проверяем код в базе данных
    const result = await pool.query(
      "SELECT * FROM verification_codes WHERE verification_code = \$1",
      [code],
    );

    // Проверяем, существует ли код
    if (result.rows.length > 0) {
      const verificationEntry = result.rows[0];

      // Удаляем код после успешной проверки
      await pool.query(
        "DELETE FROM verification_codes WHERE verification_code = \$1",
        [code],
      );

      // Отправляем ответ об успешной проверке
      return res.status(200).json({ message: "Код успешно проверен." });
    } else {
      return res.status(400).json({ message: "Код не найден." });
    }
  } catch (error) {
    console.error("Ошибка при проверке кода:", error);
    res.status(500).json({ message: "Ошибка при проверке кода." });
  }
});

// Блок для получения данных пользователя по e-mail
// Функция для расшифрования текста с использованием ключа
function decrypt(encryptedText, key) {
  const input = Buffer.from(encryptedText, "base64"); // Декодируем из base64
  const iv = input.slice(0, 12); // Извлекаем вектор инициализации (IV)
  const tag = input.slice(12, 28); // Извлекаем аутентификационный тег
  const encrypted = input.slice(28); // Извлекаем зашифрованный текст

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    iv,
  );
  decipher.setAuthTag(tag); // Устанавливаем аутентификационный тег

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]); // Расшифровываем текст
  return decrypted.toString("utf8"); // Возвращаем расшифрованный текст
}

// Получение данных
app.get("/users", async (req, res) => {
  const { email } = req.query;

  try {
    const result = await pool.query(
      "SELECT name, phone_number, address, email FROM users WHERE email = \$1",
      [email],
    );

    if (result.rows.length > 0) {
      const keyBuffer = Buffer.from(process.env.ENCRYPTION_KEY, "hex");

      // Расшифровка данных
      const decryptedName = decrypt(result.rows[0].name, keyBuffer);
      const decryptedPhoneNumber = decrypt(
        result.rows[0].phone_number,
        keyBuffer,
      );
      const decryptedAddress = decrypt(result.rows[0].address, keyBuffer);

      // Формируем ответ с расшифрованными данными
      const userData = {
        name: decryptedName,
        phone_number: decryptedPhoneNumber,
        address: decryptedAddress,
        email: result.rows[0].email, // email не зашифрован
      };

      res.status(200).json(userData);
    } else {
      res.status(404).json({ message: "Пользователь не найден" });
    }
  } catch (error) {
    console.error("Ошибка получения данных пользователя:", error);
    res.status(500).json({ message: "Ошибка сервера" });
  }
});

// Блок для добавления записи в таблицу:
app.post("/users", async (req, res) => {
  const { name, email, phoneNumber, address } = req.body;

  try {
    // Получаем ключ из переменной окружения
    const keyBuffer = Buffer.from(process.env.ENCRYPTION_KEY, "hex");

    // Шифруем данные перед вставкой в базу данных
    const encryptedName = encrypt(name, keyBuffer);
    const encryptedPhoneNumber = encrypt(phoneNumber, keyBuffer);
    const encryptedAddress = encrypt(address, keyBuffer);

    // Проверяем, есть ли пользователь с таким email
    const existingUser = await pool.query(
      "SELECT * FROM users WHERE email = \$1",
      [email],
    );

    if (existingUser.rows.length > 0) {
      // Обновляем данные пользователя, если он уже есть
      const updateQuery = `
        UPDATE users
        SET name = \$1, phone_number = \$2, address = \$3
        WHERE email = \$4
        RETURNING *;
      `;
      const values = [
        encryptedName,
        encryptedPhoneNumber,
        encryptedAddress,
        email,
      ];
      const result = await pool.query(updateQuery, values);
      return res.status(200).json(result.rows[0]);
    } else {
      // Вставляем нового пользователя
      const insertQuery = `
        INSERT INTO users (name, email, phone_number, address)
        VALUES (\$1, \$2, \$3, \$4)
        RETURNING *;
      `;
      const values = [
        encryptedName,
        email,
        encryptedPhoneNumber,
        encryptedAddress,
      ];
      const result = await pool.query(insertQuery, values);
      return res.status(201).json(result.rows[0]);
    }
  } catch (error) {
    console.error("Ошибка при сохранении данных пользователя:", error);
    res
      .status(500)
      .json({ message: "Ошибка сервера при сохранении пользователя" });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
