import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JWT_SECRET = process.env.JWT_SECRET || "cfs-secure-secret-key-hepsiba-2026";
const DATA_DIR = path.join(__dirname, "data");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Main Database for Church Registrations
const mainDb = new Database(path.join(DATA_DIR, "main.db"));
mainDb.exec(`
  CREATE TABLE IF NOT EXISTS churches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    db_path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Helper to get/initialize church database
function getChurchDb(dbPath: string) {
  const db = new Database(path.join(DATA_DIR, dbPath));
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      birth_date TEXT,
      registration_date TEXT DEFAULT (date('now'))
    );

    CREATE TABLE IF NOT EXISTS offerings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      date TEXT DEFAULT (date('now')),
      notes TEXT,
      FOREIGN KEY (member_id) REFERENCES members(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('income', 'expense')) NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      date TEXT DEFAULT (date('now')),
      description TEXT,
      member_id INTEGER,
      FOREIGN KEY (member_id) REFERENCES members(id)
    );
  `);
  return db;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Prevent caching of sensitive data
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
  });

  // Authentication Middleware
  const authenticate = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No token provided" });

    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { id: number; name: string; db_path: string };
      req.church = decoded;
      next();
    } catch (err) {
      res.status(401).json({ error: "Invalid token" });
    }
  };

  // Auth Routes
  app.get("/api/admin/debug", (req, res) => {
    res.json({ 
      status: "running",
      password_prefix: "hep...",
      env_admin_pass: !!process.env.ADMIN_PASSWORD,
      node_env: process.env.NODE_ENV || "development"
    });
  });

  app.post("/api/admin/login", (req, res) => {
    const { password } = req.body;
    console.log(`[ADMIN LOGIN] Attempt received. Password: "${password}"`);
    const ADMIN_PASSWORD = "hepsiba1234";
    
    if (password && password.trim() === ADMIN_PASSWORD) {
      console.log("[ADMIN LOGIN] Success");
      res.json({ success: true });
    } else {
      console.log(`[ADMIN LOGIN] Failed. Expected: "${ADMIN_PASSWORD}", Received: "${password}"`);
      res.status(401).json({ error: "Invalid admin password" });
    }
  });

  app.get("/api/admin/churches", (req, res) => {
    const churches = mainDb.prepare("SELECT id, name, created_at FROM churches").all();
    res.json(churches);
  });

  app.put("/api/admin/churches/:id", async (req, res) => {
    const { name, password } = req.body;
    const id = parseInt(req.params.id);

    try {
      if (password) {
        const hashedPassword = await bcrypt.hash(password, 10);
        mainDb.prepare("UPDATE churches SET name = ?, password = ? WHERE id = ?").run(name, hashedPassword, id);
      } else {
        mainDb.prepare("UPDATE churches SET name = ? WHERE id = ?").run(name, id);
      }
      res.json({ success: true });
    } catch (err: any) {
      if (err.message.includes("UNIQUE constraint failed")) {
        return res.status(400).json({ error: "이미 존재하는 교회 이름입니다." });
      }
      res.status(500).json({ error: "Server error" });
    }
  });

  app.delete("/api/admin/churches/:id", (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const church = mainDb.prepare("SELECT db_path FROM churches WHERE id = ?").get(id) as any;
      if (church) {
        // Delete the church database file
        const dbFilePath = path.join(DATA_DIR, church.db_path);
        if (fs.existsSync(dbFilePath)) {
          fs.unlinkSync(dbFilePath);
        }
        // Delete from main database
        mainDb.prepare("DELETE FROM churches WHERE id = ?").run(id);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("Delete church error:", err);
      res.status(500).json({ error: "Failed to delete church" });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: "Name and password required" });

    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      // Sanitize name for filename (remove characters that might be problematic, though modern FS handle most)
      const sanitizedName = name.replace(/[\/\\?%*:|"<>]/g, '-');
      const dbPath = `church_${Date.now()}_${sanitizedName}.db`;
      
      const info = mainDb.prepare("INSERT INTO churches (name, password, db_path) VALUES (?, ?, ?)").run(name, hashedPassword, dbPath);
      
      // Initialize the new church DB
      getChurchDb(dbPath);

      const token = jwt.sign({ id: info.lastInsertRowid, name, db_path: dbPath }, JWT_SECRET, { expiresIn: "7d" });
      res.json({ success: true, token, church: { id: info.lastInsertRowid, name } });
    } catch (err: any) {
      if (err.message.includes("UNIQUE constraint failed")) {
        return res.status(400).json({ error: "이미 존재하는 교회 이름입니다." });
      }
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { name, password } = req.body;
    const church = mainDb.prepare("SELECT * FROM churches WHERE name = ?").get(name) as any;

    if (!church || !(await bcrypt.compare(password, church.password))) {
      return res.status(401).json({ error: "교회 이름 또는 비밀번호가 일치하지 않습니다." });
    }

    const token = jwt.sign({ id: church.id, name: church.name, db_path: church.db_path }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, church: { id: church.id, name: church.name } });
  });

  // Protected API Routes
  
  // Members
  app.get("/api/members", authenticate, (req: any, res) => {
    const db = getChurchDb(req.church.db_path);
    const members = db.prepare("SELECT * FROM members ORDER BY name ASC").all();
    res.json(members);
  });

  app.post("/api/members", authenticate, (req: any, res) => {
    const { name, phone, address, birth_date } = req.body;
    const db = getChurchDb(req.church.db_path);
    const info = db.prepare("INSERT INTO members (name, phone, address, birth_date) VALUES (?, ?, ?, ?)").run(name, phone, address, birth_date);
    res.json({ id: info.lastInsertRowid });
  });

  app.put("/api/members/:id", authenticate, (req: any, res) => {
    const { name, phone, address, birth_date } = req.body;
    const db = getChurchDb(req.church.db_path);
    db.prepare("UPDATE members SET name = ?, phone = ?, address = ?, birth_date = ? WHERE id = ?").run(name, phone, address, birth_date, parseInt(req.params.id));
    res.json({ success: true });
  });

  app.delete("/api/members/:id", authenticate, (req: any, res) => {
    try {
      const db = getChurchDb(req.church.db_path);
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      console.log(`Attempting to delete member with ID: ${id}`);
      const result = db.prepare("DELETE FROM members WHERE id = ?").run(id);
      console.log(`Delete member result:`, result);
      res.json({ success: true, changes: result.changes });
    } catch (error) {
      console.error(`Delete member error:`, error);
      res.status(500).json({ error: "Failed to delete member" });
    }
  });

  // Offerings
  app.get("/api/offerings", authenticate, (req: any, res) => {
    const db = getChurchDb(req.church.db_path);
    const offerings = db.prepare(`
      SELECT o.*, m.name as member_name 
      FROM offerings o 
      LEFT JOIN members m ON o.member_id = m.id 
      ORDER BY o.date DESC
    `).all();
    res.json(offerings);
  });

  app.post("/api/offerings", authenticate, (req: any, res) => {
    const { member_id, type, amount, date, notes } = req.body;
    const db = getChurchDb(req.church.db_path);
    const info = db.prepare("INSERT INTO offerings (member_id, type, amount, date, notes) VALUES (?, ?, ?, ?, ?)").run(member_id, type, amount, date, notes);
    res.json({ id: info.lastInsertRowid });
  });

  app.put("/api/offerings/:id", authenticate, (req: any, res) => {
    const { member_id, type, amount, date, notes } = req.body;
    const db = getChurchDb(req.church.db_path);
    db.prepare("UPDATE offerings SET member_id = ?, type = ?, amount = ?, date = ?, notes = ? WHERE id = ?").run(member_id, type, amount, date, notes, parseInt(req.params.id));
    res.json({ success: true });
  });

  app.delete("/api/offerings/:id", authenticate, (req: any, res) => {
    try {
      const db = getChurchDb(req.church.db_path);
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      console.log(`Attempting to delete offering with ID: ${id}`);
      const result = db.prepare("DELETE FROM offerings WHERE id = ?").run(id);
      console.log(`Delete offering result:`, result);
      res.json({ success: true, changes: result.changes });
    } catch (error) {
      console.error(`Delete offering error:`, error);
      res.status(500).json({ error: "Failed to delete offering" });
    }
  });

  // Transactions
  app.get("/api/transactions", authenticate, (req: any, res) => {
    const db = getChurchDb(req.church.db_path);
    const transactions = db.prepare(`
      SELECT t.*, m.name as member_name 
      FROM transactions t 
      LEFT JOIN members m ON t.member_id = m.id 
      ORDER BY t.date DESC
    `).all();
    res.json(transactions);
  });

  app.post("/api/transactions", authenticate, (req: any, res) => {
    const { type, category, amount, date, description, member_id } = req.body;
    const db = getChurchDb(req.church.db_path);
    const info = db.prepare("INSERT INTO transactions (type, category, amount, date, description, member_id) VALUES (?, ?, ?, ?, ?, ?)").run(type, category, amount, date, description, member_id);
    res.json({ id: info.lastInsertRowid });
  });

  app.put("/api/transactions/:id", authenticate, (req: any, res) => {
    const { type, category, amount, date, description, member_id } = req.body;
    const db = getChurchDb(req.church.db_path);
    db.prepare("UPDATE transactions SET type = ?, category = ?, amount = ?, date = ?, description = ?, member_id = ? WHERE id = ?").run(type, category, amount, date, description, member_id, parseInt(req.params.id));
    res.json({ success: true });
  });

  app.delete("/api/transactions/:id", authenticate, (req: any, res) => {
    try {
      const db = getChurchDb(req.church.db_path);
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      console.log(`Attempting to delete transaction with ID: ${id}`);
      const result = db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
      console.log(`Delete transaction result:`, result);
      res.json({ success: true, changes: result.changes });
    } catch (error) {
      console.error(`Delete transaction error:`, error);
      res.status(500).json({ error: "Failed to delete transaction" });
    }
  });

  // Stats
  app.get("/api/stats", authenticate, (req: any, res) => {
    const db = getChurchDb(req.church.db_path);
    const totalOfferings = db.prepare("SELECT SUM(amount) as total FROM offerings").get() as { total: number };
    const totalIncome = db.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'income'").get() as { total: number };
    const totalExpense = db.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'expense'").get() as { total: number };
    const memberCount = db.prepare("SELECT COUNT(*) as count FROM members").get() as { count: number };

    const combinedIncome = (totalIncome.total || 0) + (totalOfferings.total || 0);

    res.json({
      totalOfferings: 0, // Removed from UI
      totalIncome: combinedIncome,
      totalExpense: totalExpense.total || 0,
      memberCount: memberCount.count || 0
    });
  });

  // Reports
  app.get("/api/reports/summary", authenticate, (req: any, res) => {
    const { start, end } = req.query;
    const db = getChurchDb(req.church.db_path);
    const offerings = db.prepare("SELECT type as category, SUM(amount) as total FROM offerings WHERE date BETWEEN ? AND ? GROUP BY type").all(start, end);
    const otherIncomes = db.prepare("SELECT category, SUM(amount) as total FROM transactions WHERE type = 'income' AND date BETWEEN ? AND ? GROUP BY category").all(start, end);
    const expenses = db.prepare("SELECT category, SUM(amount) as total FROM transactions WHERE type = 'expense' AND date BETWEEN ? AND ? GROUP BY category").all(start, end);
    
    // Merge offerings into incomes
    const combinedIncomes = [...offerings, ...otherIncomes];
    
    res.json({ offerings: [], otherIncomes: combinedIncomes, expenses });
  });

  app.get("/api/reports/receipt/:memberId", authenticate, (req: any, res) => {
    const { year } = req.query;
    const db = getChurchDb(req.church.db_path);
    const member = db.prepare("SELECT * FROM members WHERE id = ?").get(req.params.memberId);
    
    // Get from offerings table
    const offerings = db.prepare("SELECT type, SUM(amount) as total FROM offerings WHERE member_id = ? AND date LIKE ? GROUP BY type").all(req.params.memberId, `${year}%`);
    
    // Get from transactions table (income categories that are offerings)
    const transactionOfferings = db.prepare(`
      SELECT category as type, SUM(amount) as total 
      FROM transactions 
      WHERE member_id = ? AND type = 'income' AND date LIKE ? 
      GROUP BY category
    `).all(req.params.memberId, `${year}%`);

    // Merge results
    const mergedOfferings: any[] = [...offerings];
    transactionOfferings.forEach((to: any) => {
      const existing = mergedOfferings.find(o => o.type === to.type);
      if (existing) {
        existing.total += to.total;
      } else {
        mergedOfferings.push(to);
      }
    });

    res.json({ member, offerings: mergedOfferings, year });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
