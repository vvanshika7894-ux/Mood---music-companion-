const db = require("./database");
const bcrypt = require("bcrypt");


// REGISTER
function register(username, password) {

    const existing = db
        .prepare("SELECT id FROM users WHERE username = ?")
        .get(username);

    if (existing) {
        throw new Error("User already exists");
    }

    const hash = bcrypt.hashSync(password, 10);

    const result = db.prepare(`
        INSERT INTO users (username, password)
        VALUES (?, ?)
    `).run(username, hash);

    return {
        id: result.lastInsertRowid,
        username
    };
}


// LOGIN
function login(username, password) {

    const user = db
        .prepare("SELECT * FROM users WHERE username = ?")
        .get(username);

    if (!user) {
        throw new Error("Invalid username or password");
    }

    const match = bcrypt.compareSync(password, user.password);

    if (!match) {
        throw new Error("Invalid username or password");
    }

    return {
        id: user.id,
        username: user.username
    };
}

module.exports = {
    register,
    login
};
