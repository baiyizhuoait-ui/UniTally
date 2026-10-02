const bcrypt = require('bcryptjs');
const { saveDb } = require('../db');

// User class for in-memory storage
class User {
  constructor(data) {
    this.id = data.id || Date.now().toString();
    this.name = data.name;
    this.email = data.email.toLowerCase();
    this.password = data.password;
    this.avatar = data.avatar || '';
    this.provider = data.provider;
    this.googleId = data.googleId;
    this.isVerified = data.isVerified || false;
    this.verificationToken = data.verificationToken;
    this.resetPasswordToken = data.resetPasswordToken;
    this.resetPasswordExpires = data.resetPasswordExpires;
    this.createdAt = data.createdAt || Date.now();
  }

  // Hash password
  async hashPassword() {
    if (this.password) {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
    }
  }

  // Compare password
  async comparePassword(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
  }
}

// User methods for in-memory database
const UserModel = {
  // Find user by email
  findOne: async function(db, query) {
    let user = null;
    if (query.email) {
      user = db.users.find((u) => u.email === query.email.toLowerCase());
    } else if (query._id) {
      user = db.users.find((u) => u.id === query._id);
    }
    // Rehydrate plain (file-loaded) objects into User instances so methods work.
    if (user && !(user instanceof User)) {
      Object.setPrototypeOf(user, User.prototype);
    }
    return user;
  },

  // Create new user
  create: async function(db, data) {
    const user = new User(data);
    await user.hashPassword();
    db.users.push(user);
    saveDb(db);
    return user;
  },

  // Update user
  update: async function(db, query, update) {
    const user = await this.findOne(db, query);
    if (user) {
      Object.assign(user, update);
      if (update.password) {
        await user.hashPassword();
      }
      saveDb(db);
    }
    return user;
  },

  // Delete user
  delete: async function(db, query) {
    const index = db.users.findIndex((user) => user.email === query.email.toLowerCase());
    if (index > -1) {
      db.users.splice(index, 1);
      saveDb(db);
      return true;
    }
    return false;
  }
};

module.exports = UserModel;
