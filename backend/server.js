import express from "express";
import session from "express-session";
import pg from "pg";
import bcrypt from "bcrypt";
import connectPgSimple from "connect-pg-simple";
import dotenv from "dotenv";
import { pathToFileURL, fileURLToPath } from "url";
import path from "path";
import { priceTrackingRouter } from "./routes/priceTracking.js";
import { chatRouter } from "./routes/chat.js";
import fetch from "node-fetch";

import {
  checkCpuMotherboardCompatibility,
  checkRamMotherboardCompatibility,
  checkPsuWattageCompatibility,
  checkRamCapacityCompatibility,
} from "./compatibilityEngine.js";

import { calculateBuildScore } from "./performanceScoring.js";

// Keep dotenv quiet during tests to reduce noise in test output.
dotenv.config({ quiet: process.env.NODE_ENV === "test" });

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "connect.sid";

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseAllowedOrigins(originsValue = process.env.FRONTEND_ORIGIN) {
  if (!originsValue) return [];

  return originsValue
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function applyCors(app, allowedOrigins = parseAllowedOrigins()) {
  if (allowedOrigins.length === 0) return;

  const allowedOriginSet = new Set(allowedOrigins);

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (!origin || !allowedOriginSet.has(origin)) {
      return next();
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.append("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    return next();
  });
}

function getSessionCookieConfig() {
  const isProduction = process.env.NODE_ENV === "production";
  const configuredSameSite = process.env.SESSION_COOKIE_SAMESITE?.trim().toLowerCase();
  const validSameSite = new Set(["none", "lax", "strict"]);
  const sameSite = validSameSite.has(configuredSameSite)
    ? configuredSameSite
    : isProduction
      ? "none"
      : "lax";

  let secure = parseBooleanEnv(process.env.SESSION_COOKIE_SECURE, isProduction);
  if (sameSite === "none") {
    secure = true;
  }

  return {
    httpOnly: true,
    sameSite,
    secure,
    maxAge: 1000 * 60 * 60 * 8,
  };
}

function buildCompatibilityResponse(body = {}) {
  const { cpu, motherboard, ram, gpu, psu } = body;

  const cpuResult = checkCpuMotherboardCompatibility(cpu, motherboard);
  const ramTypeResult = checkRamMotherboardCompatibility(ram, motherboard);
  const psuResult = checkPsuWattageCompatibility(psu, cpu, gpu);
  const ramCapacityResult = checkRamCapacityCompatibility(ram, motherboard);

  const issues = [
    ...cpuResult.issues,
    ...ramTypeResult.issues,
    ...psuResult.issues,
    ...ramCapacityResult.issues,
  ];

  return {
    compatible: issues.length === 0,
    issues,
  };
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0].trim();
  }

  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ ok: false, error: "Not Logged in" });
  }

  return next();
}

function createNoOpAuthLogger() {
  return {
    async logEvent() {},
    async getRecentEventsForUser() {
      return [];
    },
  };
}

export function createPool(connectionString = process.env.DATABASE_URL) {
  return new pg.Pool({ connectionString });
}

function normalizePartCategory(type) {
  const normalized = String(type ?? "")
    .trim()
    .toLowerCase();

  if (!normalized) return "part";
  if (normalized.includes("mother")) return "mobo";
  if (normalized.includes("mainboard")) return "mobo";
  if (normalized === "mobo") return "mobo";
  if (normalized.includes("graphics")) return "gpu";
  if (normalized.includes("video")) return "gpu";
  if (normalized.includes("memory")) return "ram";
  if (normalized.includes("power supply")) return "psu";

  return normalized.replace(/\s+/g, "_");
}

function buildPartsObject(partRows = []) {
  return partRows.reduce((parts, row) => {
    const key = normalizePartCategory(row.type);
    parts[key] = {
      sku: row.sku === null ? null : Number(row.sku),
      type: row.type,
      name: row.name,
      price: row.price === null ? null : Number(row.price),
      inventory: row.inventory === null ? null : Number(row.inventory),
    };
    return parts;
  }, {});
}

function buildSavedBuildResponse(buildRow, partRows = []) {
  const parts = buildPartsObject(partRows);
  const cpuName = parts.cpu?.name ?? "Custom";
  const gpuName = parts.gpu?.name ?? "Build";

  return {
    id: Number(buildRow.build_id),
    title: `${cpuName} + ${gpuName}`,
    totalPrice: buildRow.price === null ? null : Number(buildRow.price),
    budget: null,
    compatible: Boolean(buildRow.validated),
    performanceScore: calculateBuildScore(parts),
    parts,
    createdAt: null,
  };
}

function isSchemaMismatchError(error) {
  return ["42703", "42P01", "42704"].includes(error?.code);
}

async function createUserRecord(pool, email, passwordHash) {
  try {
    return await pool.query(
      `INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id, email`,
      [email, passwordHash]
    );
  } catch (error) {
    if (!isSchemaMismatchError(error)) {
      throw error;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const userResult = await client.query(
        `INSERT INTO users(username, email) VALUES ($1, $2) RETURNING uid AS id, email`,
        [null, email]
      );
      await client.query(`INSERT INTO auth(uid, password_hash) VALUES ($1, $2)`, [
        userResult.rows[0].id,
        passwordHash,
      ]);
      await client.query("COMMIT");
      return userResult;
    } catch (transactionError) {
      await client.query("ROLLBACK").catch(() => {});
      throw transactionError;
    } finally {
      client.release();
    }
  }
}

async function findUserByEmail(pool, email) {
  try {
    return await pool.query(`SELECT id, email, password_hash FROM users WHERE email = $1`, [email]);
  } catch (error) {
    if (!isSchemaMismatchError(error)) {
      throw error;
    }

    return pool.query(
      `SELECT users.uid AS id, users.email, auth.password_hash
         FROM users
         JOIN auth ON auth.uid = users.uid
        WHERE users.email = $1`,
      [email]
    );
  }
}

async function findUserById(pool, userId) {
  try {
    return await pool.query("SELECT id, email FROM users WHERE id = $1", [userId]);
  } catch (error) {
    if (!isSchemaMismatchError(error)) {
      throw error;
    }

    return pool.query("SELECT uid AS id, email FROM users WHERE uid = $1", [userId]);
  }
}

export async function ensureAuthLogTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_logs (
      log_id BIGSERIAL PRIMARY KEY,
      auth_id BIGINT REFERENCES auth(auth_id) ON DELETE CASCADE,
      uid INTEGER REFERENCES auth(uid) ON DELETE SET NULL,
      attempted_email TEXT,
      event_type TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      failure_reason TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function ensureSavedBuildTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS builds (
      build_id BIGSERIAL PRIMARY KEY,
      uid BIGINT REFERENCES users(uid) ON DELETE CASCADE,
      price NUMERIC(10, 2),
      validated BOOLEAN DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS build_pc_parts (
      junction_id BIGSERIAL PRIMARY KEY,
      build_id BIGINT NOT NULL REFERENCES builds(build_id) ON DELETE CASCADE,
      sku BIGINT NOT NULL REFERENCES pc_parts(sku) ON DELETE CASCADE
    )
  `);
}

function normalizeSavedBuildRow(row) {
  return buildSavedBuildResponse(row, row.part_rows ?? []);
}

export function createAuthLogger(pool) {
  if (!pool) throw new Error("Pool is required");

  return {
    async logEvent({
                     userId = null,
                     attemptedEmail = null,
                     eventType,
                     success,
                     failureReason = null,
                     ipAddress = null,
                     userAgent = null,
                   }) {
      const { rows: authRows } = await pool.query(
        `
          SELECT a.auth_id, a.uid
          FROM auth a
          LEFT JOIN users u ON u.uid = a.uid
          WHERE ($1::bigint IS NOT NULL AND a.uid = $1)
             OR ($1::bigint IS NULL AND $2::text IS NOT NULL AND u.email = $2)
          ORDER BY a.auth_id ASC
          LIMIT 1
        `,
        [userId, attemptedEmail]
      );

      const authRow = authRows[0];

      if (!authRow?.auth_id) {
        return;
      }

      await pool.query(
          `INSERT INTO auth_logs
           (auth_id, uid, attempted_email, event_type, success, failure_reason, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            authRow.auth_id,
            authRow.uid,
            attemptedEmail,
            eventType,
            success,
            failureReason,
            ipAddress,
            userAgent,
          ]
      );
    },

    async getRecentEventsForUser({ userId, limit = 50 }) {
      const { rows } = await pool.query(
          `SELECT log_id, auth_id, uid, attempted_email, event_type, success, failure_reason, ip_address,
                  user_agent, created_at
           FROM auth_logs
           WHERE uid = $1
           ORDER BY created_at DESC
             LIMIT $2`,
          [userId, limit]
      );

      return rows;
    },
  };
}

export function createSessionMiddleware(
  pool,
  sessionSecret = process.env.SESSION_SECRET,
  sessionStore
) {
  if (!sessionSecret) throw new Error("Session_secret missing!");

  const store =
    sessionStore ??
    new (connectPgSimple(session))({
      pool,
      tableName: "session",
      createTableIfMissing: true,
    });

  const cookieConfig = getSessionCookieConfig();

  return session({
    name: SESSION_COOKIE_NAME,
    store,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: cookieConfig,
  });
}

export function createApp({
  pool,
  bcryptLib = bcrypt,
  bcryptImpl,
  sessionMiddleware,
  sessionSecret = process.env.SESSION_SECRET,
  sessionStore,
  authLogger,
} = {}) {
  if (!pool) throw new Error("Pool is required");

  const resolvedBcrypt = bcryptImpl ?? bcryptLib;
  const resolvedSessionMiddleware =
    sessionMiddleware ?? createSessionMiddleware(pool, sessionSecret, sessionStore);
  const resolvedAuthLogger =
    authLogger ?? (process.env.NODE_ENV === "test" ? createNoOpAuthLogger() : createAuthLogger(pool));
  const safeLogAuthEvent = async (event) => {
    try {
      await resolvedAuthLogger.logEvent(event);
    } catch (loggingError) {
      console.error("Auth logging failed", loggingError);
    }
  };

  const app = express();
  const trustProxy = parseBooleanEnv(
    process.env.TRUST_PROXY,
    process.env.NODE_ENV === "production"
  );

  if (trustProxy) {
    app.set("trust proxy", 1);
  }

  applyCors(app);

  app.use(express.json());

  // Serve static images from backend/data/images
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  app.use("/images", express.static(path.join(__dirname, "data", "images")));

  app.use("/api", priceTrackingRouter);
  app.use("/api", chatRouter);

  app.get("/", (req, res) => {
    res.type("text").send("ok");
  });

  app.get("/favicon.ico", (req, res) => {
    res.status(204).end();
  });

  app.post("/api/compatibility", (req, res) => {
    return res.json(buildCompatibilityResponse(req.body));
  });

  const PARTS_CATALOG = {
    cpu: [
      // AMD Ryzen 9000 Series (Zen 5) - AM5
      { id: "cpu-1",  name: "AMD Ryzen 9 9950X",     price: 549, tdp: 170, socket: "AM5", microarchitecture: "Zen 5", core_count: 16, boost_clock: 5.7, img: "/images/processor.png" },
      { id: "cpu-2",  name: "AMD Ryzen 9 9900X",     price: 449, tdp: 120, socket: "AM5", microarchitecture: "Zen 5", core_count: 12, boost_clock: 5.6, img: "/images/processor.png" },
      { id: "cpu-3",  name: "AMD Ryzen 7 9800X3D",   price: 479, tdp: 120, socket: "AM5", microarchitecture: "Zen 5", core_count: 8,  boost_clock: 5.2, img: "/images/processor.png" },
      { id: "cpu-4",  name: "AMD Ryzen 7 9700X",     price: 265, tdp: 65,  socket: "AM5", microarchitecture: "Zen 5", core_count: 8,  boost_clock: 5.5, img: "/images/processor.png" },
      { id: "cpu-5",  name: "AMD Ryzen 5 9600X",     price: 179, tdp: 65,  socket: "AM5", microarchitecture: "Zen 5", core_count: 6,  boost_clock: 5.4, img: "/images/processor.png" },
      // AMD Ryzen 7000 Series (Zen 4) - AM5
      { id: "cpu-6",  name: "AMD Ryzen 9 7950X3D",   price: 699, tdp: 120, socket: "AM5", microarchitecture: "Zen 4", core_count: 16, boost_clock: 5.7, img: "/images/processor.png" },
      { id: "cpu-7",  name: "AMD Ryzen 9 7950X",     price: 449, tdp: 170, socket: "AM5", microarchitecture: "Zen 4", core_count: 16, boost_clock: 5.7, img: "/images/processor.png" },
      { id: "cpu-8",  name: "AMD Ryzen 9 7900X",     price: 349, tdp: 170, socket: "AM5", microarchitecture: "Zen 4", core_count: 12, boost_clock: 5.6, img: "/images/processor.png" },
      { id: "cpu-9",  name: "AMD Ryzen 7 7800X3D",   price: 399, tdp: 120, socket: "AM5", microarchitecture: "Zen 4", core_count: 8,  boost_clock: 5.0, img: "/images/processor.png" },
      { id: "cpu-10", name: "AMD Ryzen 7 7700X",     price: 249, tdp: 105, socket: "AM5", microarchitecture: "Zen 4", core_count: 8,  boost_clock: 5.4, img: "/images/processor.png" },
      { id: "cpu-11", name: "AMD Ryzen 5 7600X",     price: 199, tdp: 105, socket: "AM5", microarchitecture: "Zen 4", core_count: 6,  boost_clock: 5.3, img: "/images/processor.png" },
      { id: "cpu-12", name: "AMD Ryzen 5 7600",      price: 179, tdp: 65,  socket: "AM5", microarchitecture: "Zen 4", core_count: 6,  boost_clock: 5.1, img: "/images/processor.png" },
      // AMD Ryzen 5000 Series (Zen 3) - AM4
      { id: "cpu-13", name: "AMD Ryzen 9 5900X",     price: 249, tdp: 105, socket: "AM4", microarchitecture: "Zen 3", core_count: 12, boost_clock: 4.8, img: "/images/processor.png" },
      { id: "cpu-14", name: "AMD Ryzen 7 5800X3D",   price: 299, tdp: 105, socket: "AM4", microarchitecture: "Zen 3", core_count: 8,  boost_clock: 4.5, img: "/images/processor.png" },
      { id: "cpu-15", name: "AMD Ryzen 7 5800X",     price: 179, tdp: 105, socket: "AM4", microarchitecture: "Zen 3", core_count: 8,  boost_clock: 4.7, img: "/images/processor.png" },
      { id: "cpu-16", name: "AMD Ryzen 7 5700X",     price: 149, tdp: 65,  socket: "AM4", microarchitecture: "Zen 3", core_count: 8,  boost_clock: 4.6, img: "/images/processor.png" },
      { id: "cpu-17", name: "AMD Ryzen 5 5600X",     price: 139, tdp: 65,  socket: "AM4", microarchitecture: "Zen 3", core_count: 6,  boost_clock: 4.6, img: "/images/processor.png" },
      { id: "cpu-18", name: "AMD Ryzen 5 5600",      price: 119, tdp: 65,  socket: "AM4", microarchitecture: "Zen 3", core_count: 6,  boost_clock: 4.4, img: "/images/processor.png" },
      // Intel Core Ultra 200S (Arrow Lake Refresh) - LGA1851
      { id: "cpu-19", name: "Intel Core Ultra 9 285K",   price: 589, tdp: 125, socket: "LGA1851", microarchitecture: "Arrow Lake", core_count: 24, boost_clock: 5.7, img: "/images/processor.png" },
      { id: "cpu-20", name: "Intel Core Ultra 7 270K",   price: 349, tdp: 125, socket: "LGA1851", microarchitecture: "Arrow Lake", core_count: 20, boost_clock: 5.5, img: "/images/processor.png" },
      { id: "cpu-21", name: "Intel Core Ultra 7 265K",   price: 299, tdp: 125, socket: "LGA1851", microarchitecture: "Arrow Lake", core_count: 20, boost_clock: 5.5, img: "/images/processor.png" },
      { id: "cpu-22", name: "Intel Core Ultra 5 250K",   price: 219, tdp: 125, socket: "LGA1851", microarchitecture: "Arrow Lake", core_count: 14, boost_clock: 5.2, img: "/images/processor.png" },
      { id: "cpu-23", name: "Intel Core Ultra 5 245K",   price: 199, tdp: 125, socket: "LGA1851", microarchitecture: "Arrow Lake", core_count: 14, boost_clock: 5.2, img: "/images/processor.png" },
      // Intel 14th Gen (Raptor Lake Refresh) - LGA1700
      { id: "cpu-24", name: "Intel Core i9-14900K",  price: 449, tdp: 125, socket: "LGA1700", microarchitecture: "Raptor Lake Refresh", core_count: 24, boost_clock: 6.0, img: "/images/processor.png" },
      { id: "cpu-25", name: "Intel Core i7-14700K",  price: 319, tdp: 125, socket: "LGA1700", microarchitecture: "Raptor Lake Refresh", core_count: 20, boost_clock: 5.6, img: "/images/processor.png" },
      { id: "cpu-26", name: "Intel Core i5-14600K",  price: 259, tdp: 125, socket: "LGA1700", microarchitecture: "Raptor Lake Refresh", core_count: 14, boost_clock: 5.3, img: "/images/processor.png" },
      { id: "cpu-27", name: "Intel Core i5-14400F",  price: 149, tdp: 65,  socket: "LGA1700", microarchitecture: "Raptor Lake Refresh", core_count: 10, boost_clock: 4.7, img: "/images/processor.png" },
      // Intel 13th Gen (Raptor Lake) - LGA1700
      { id: "cpu-28", name: "Intel Core i9-13900K",  price: 419, tdp: 125, socket: "LGA1700", microarchitecture: "Raptor Lake", core_count: 24, boost_clock: 5.8, img: "/images/processor.png" },
      { id: "cpu-29", name: "Intel Core i7-13700K",  price: 299, tdp: 125, socket: "LGA1700", microarchitecture: "Raptor Lake", core_count: 16, boost_clock: 5.4, img: "/images/processor.png" },
      { id: "cpu-30", name: "Intel Core i5-13600K",  price: 249, tdp: 125, socket: "LGA1700", microarchitecture: "Raptor Lake", core_count: 14, boost_clock: 5.1, img: "/images/processor.png" },
      { id: "cpu-31", name: "Intel Core i5-13400F",  price: 139, tdp: 65,  socket: "LGA1700", microarchitecture: "Raptor Lake", core_count: 10, boost_clock: 4.6, img: "/images/processor.png" },
      // Intel 12th Gen (Alder Lake) - LGA1700
      { id: "cpu-32", name: "Intel Core i7-12700K",  price: 199, tdp: 125, socket: "LGA1700", microarchitecture: "Alder Lake", core_count: 12, boost_clock: 5.0, img: "/images/processor.png" },
      { id: "cpu-33", name: "Intel Core i5-12600K",  price: 149, tdp: 125, socket: "LGA1700", microarchitecture: "Alder Lake", core_count: 10, boost_clock: 4.9, img: "/images/processor.png" },
      { id: "cpu-34", name: "Intel Core i5-12400F",  price: 109, tdp: 65,  socket: "LGA1700", microarchitecture: "Alder Lake", core_count: 6,  boost_clock: 4.4, img: "/images/processor.png" },
      { id: "cpu-35", name: "Intel Core i3-12100F",  price: 79,  tdp: 58,  socket: "LGA1700", microarchitecture: "Alder Lake", core_count: 4,  boost_clock: 4.3, img: "/images/processor.png" },
    ],
    gpu: [
      { id: "gpu-1",  name: "NVIDIA RTX 3060",        price: 329, tdp: 170, img: "/images/graphicscard.png", alt: "NVIDIA RTX 3060" },
      { id: "gpu-2",  name: "NVIDIA RTX 3060 Ti",     price: 399, tdp: 200, img: "/images/graphicscard.png", alt: "NVIDIA RTX 3060 Ti" },
      { id: "gpu-3",  name: "NVIDIA RTX 3070",        price: 499, tdp: 220, img: "/images/graphicscard.png", alt: "NVIDIA RTX 3070" },
      { id: "gpu-4",  name: "NVIDIA RTX 3080",        price: 699, tdp: 320, img: "/images/graphicscard.png", alt: "NVIDIA RTX 3080" },
      { id: "gpu-5",  name: "NVIDIA RTX 4060",        price: 299, tdp: 115, img: "/images/graphicscard.png", alt: "NVIDIA RTX 4060" },
      { id: "gpu-6",  name: "NVIDIA RTX 4070",        price: 599, tdp: 200, img: "/images/graphicscard.png", alt: "NVIDIA RTX 4070" },
      { id: "gpu-7",  name: "AMD Radeon RX 6600",     price: 249, tdp: 132, img: "/images/graphicscard.png", alt: "AMD Radeon RX 6600" },
      { id: "gpu-8",  name: "AMD Radeon RX 6700 XT",  price: 349, tdp: 230, img: "/images/graphicscard.png", alt: "AMD Radeon RX 6700 XT" },
      { id: "gpu-9",  name: "AMD Radeon RX 6800 XT",  price: 549, tdp: 300, img: "/images/graphicscard.png", alt: "AMD Radeon RX 6800 XT" },
      { id: "gpu-10", name: "AMD Radeon RX 7900 XTX", price: 949, tdp: 355, img: "/images/graphicscard.png", alt: "AMD Radeon RX 7900 XTX" },
    ],
    ram: [
      { id: "ram-1", name: "Corsair Vengeance 16GB DDR4-3200", price: 45,  type: "DDR4", img: "/images/ram.png", alt: "Corsair Vengeance 16GB DDR4-3200" },
      { id: "ram-2", name: "G.Skill Ripjaws 16GB DDR4-3600",  price: 55,  type: "DDR4", img: "/images/ram.png", alt: "G.Skill Ripjaws 16GB DDR4-3600" },
      { id: "ram-3", name: "Kingston Fury 32GB DDR4-3200",    price: 79,  type: "DDR4", img: "/images/ram.png", alt: "Kingston Fury 32GB DDR4-3200" },
      { id: "ram-4", name: "Corsair Vengeance 32GB DDR4-3600",price: 95,  type: "DDR4", img: "/images/ram.png", alt: "Corsair Vengeance 32GB DDR4-3600" },
      { id: "ram-5", name: "G.Skill Trident 64GB DDR4-3600",  price: 159, type: "DDR4", img: "/images/ram.png", alt: "G.Skill Trident 64GB DDR4-3600" },
      { id: "ram-6", name: "Corsair Vengeance 16GB DDR5-4800",price: 75,  type: "DDR5", img: "/images/ram.png", alt: "Corsair Vengeance 16GB DDR5-4800" },
      { id: "ram-7", name: "G.Skill Trident 32GB DDR5-6000",  price: 119, type: "DDR5", img: "/images/ram.png", alt: "G.Skill Trident 32GB DDR5-6000" },
      { id: "ram-8", name: "Kingston Fury 32GB DDR5-5200",    price: 109, type: "DDR5", img: "/images/ram.png", alt: "Kingston Fury 32GB DDR5-5200" },
      { id: "ram-9", name: "Corsair Dominator 64GB DDR5-5600",price: 229, type: "DDR5", img: "/images/ram.png", alt: "Corsair Dominator 64GB DDR5-5600" },
    ],
    mobo: [
      { id: "mobo-1",  name: "MSI B550-A Pro",             price: 129, socket: "AM4",     ramType: "DDR4", img: "/images/motherboard.png", alt: "MSI B550-A Pro" },
      { id: "mobo-2",  name: "ASUS TUF B550-Plus",         price: 149, socket: "AM4",     ramType: "DDR4", img: "/images/motherboard.png", alt: "ASUS TUF B550-Plus" },
      { id: "mobo-3",  name: "ASUS ROG STRIX B550-F",      price: 180, socket: "AM4",     ramType: "DDR4", img: "/images/motherboard.png", alt: "ASUS ROG STRIX B550-F" },
      { id: "mobo-4",  name: "MSI B550 Tomahawk",          price: 159, socket: "AM4",     ramType: "DDR4", img: "/images/motherboard.png", alt: "MSI B550 Tomahawk" },
      { id: "mobo-5",  name: "ASUS ROG Crosshair X670E",   price: 349, socket: "AM5",     ramType: "DDR5", img: "/images/motherboard.png", alt: "ASUS ROG Crosshair X670E" },
      { id: "mobo-6",  name: "MSI X670E Tomahawk",         price: 299, socket: "AM5",     ramType: "DDR5", img: "/images/motherboard.png", alt: "MSI X670E Tomahawk" },
      { id: "mobo-7",  name: "Gigabyte B650 Aorus Elite",  price: 199, socket: "AM5",     ramType: "DDR5", img: "/images/motherboard.png", alt: "Gigabyte B650 Aorus Elite" },
      { id: "mobo-8",  name: "ASUS Prime Z690-A",          price: 219, socket: "LGA1700", ramType: "DDR4", img: "/images/motherboard.png", alt: "ASUS Prime Z690-A" },
      { id: "mobo-9",  name: "MSI Z690-A Pro",             price: 189, socket: "LGA1700", ramType: "DDR4", img: "/images/motherboard.png", alt: "MSI Z690-A Pro" },
      { id: "mobo-10", name: "ASUS ROG Strix Z790-E",      price: 399, socket: "LGA1700", ramType: "DDR5", img: "/images/motherboard.png", alt: "ASUS ROG Strix Z790-E" },
      { id: "mobo-11", name: "MSI Z790 Edge",              price: 329, socket: "LGA1700", ramType: "DDR5", img: "/images/motherboard.png", alt: "MSI Z790 Edge" },
    ],
    psu: [
      { id: "psu-1",  name: "EVGA 500W Bronze",          price: 49,  wattage: 500,  img: "/images/powersupply.png", alt: "EVGA 500W Bronze" },
      { id: "psu-2",  name: "Corsair CV550",             price: 59,  wattage: 550,  img: "/images/powersupply.png", alt: "Corsair CV550" },
      { id: "psu-3",  name: "Corsair CX650M",            price: 79,  wattage: 650,  img: "/images/powersupply.png", alt: "Corsair CX650M" },
      { id: "psu-4",  name: "EVGA 650W Gold",            price: 89,  wattage: 650,  img: "/images/powersupply.png", alt: "EVGA 650W Gold" },
      { id: "psu-5",  name: "Seasonic Focus GX-750",     price: 129, wattage: 750,  img: "/images/powersupply.png", alt: "Seasonic Focus GX-750" },
      { id: "psu-6",  name: "Corsair RM750x",            price: 119, wattage: 750,  img: "/images/powersupply.png", alt: "Corsair RM750x" },
      { id: "psu-7",  name: "be quiet! Pure Power 850W", price: 139, wattage: 850,  img: "/images/powersupply.png", alt: "be quiet! Pure Power 850W" },
      { id: "psu-8",  name: "Corsair RM850x",            price: 149, wattage: 850,  img: "/images/powersupply.png", alt: "Corsair RM850x" },
      { id: "psu-9",  name: "Seasonic Focus GX-1000",    price: 189, wattage: 1000, img: "/images/powersupply.png", alt: "Seasonic Focus GX-1000" },
      { id: "psu-10", name: "Corsair HX1000",            price: 199, wattage: 1000, img: "/images/powersupply.png", alt: "Corsair HX1000" },
    ],
  };

  function recommendBuild(budget) {
    // Budget split: GPU gets the most, then CPU, mobo, psu, ram
    const alloc = { gpu: 0.38, cpu: 0.22, mobo: 0.18, psu: 0.12, ram: 0.10 };

    // Sort each category best (most expensive) first
    const sorted = {};
    for (const [cat, parts] of Object.entries(PARTS_CATALOG)) {
      sorted[cat] = [...parts].sort((a, b) => b.price - a.price);
    }

    // Pick best GPU within allocation
    const gpu = sorted.gpu.find(p => p.price <= budget * alloc.gpu)
      ?? sorted.gpu[sorted.gpu.length - 1];

    // Pick best CPU within allocation
    const cpu = sorted.cpu.find(p => p.price <= budget * alloc.cpu)
      ?? sorted.cpu[sorted.cpu.length - 1];

    // Pick best Mobo that matches CPU socket
    const mobo = sorted.mobo.find(p => p.socket === cpu.socket && p.price <= budget * alloc.mobo)
      ?? sorted.mobo.find(p => p.socket === cpu.socket);

    // Pick best RAM that matches Mobo RAM type
    const ram = sorted.ram.find(p => p.type === mobo.ramType && p.price <= budget * alloc.ram)
      ?? sorted.ram.find(p => p.type === mobo.ramType);

    // Pick PSU that covers CPU + GPU + mobo overhead with 20% headroom
    const requiredWattage = Math.ceil((cpu.tdp + gpu.tdp + 35) * 1.2);
    const psu = sorted.psu.find(p => p.wattage >= requiredWattage && p.price <= budget * alloc.psu)
      ?? sorted.psu.find(p => p.wattage >= requiredWattage)
      ?? sorted.psu[sorted.psu.length - 1];

    return { cpu, gpu, ram, mobo, psu };
  }

  app.get("/api/parts", (req, res) => {
    // Prepend the backend origin to relative image paths
    const origin = `${req.protocol}://${req.get("host")}`;
    const partsWithImages = {};
    for (const [cat, items] of Object.entries(PARTS_CATALOG)) {
      partsWithImages[cat] = items.map(p => ({
        ...p,
        img: p.img?.startsWith("/") ? `${origin}${p.img}` : p.img,
      }));
    }
    return res.json({ ok: true, parts: partsWithImages });
  });

  app.post("/api/recommend", (req, res) => {
    const budget = Number(req.body?.budget);

    if (!budget || budget <= 0) {
      return res.status(400).json({ ok: false, error: "Valid budget is required" });
    }

    const parts = recommendBuild(budget);
    const totalPrice = Object.values(parts).reduce((sum, p) => sum + (p?.price ?? 0), 0);

    return res.json({ ok: true, parts, totalPrice });
  });

  app.post("/api/build-analysis", (req, res) => {
    const { cpu, motherboard, ram, gpu, psu } = req.body ?? {};

    const compatibility = buildCompatibilityResponse(req.body);

    const estimatedPower =
      (typeof cpu?.tdp === "number" ? cpu.tdp : 0) +
      (typeof gpu?.tdp === "number" ? gpu.tdp : 0) +
      100;

    return res.json({
      ...compatibility,
      estimatedPower,
      parts: {
        cpu,
        motherboard,
        ram,
        gpu,
        psu,
      },
    });
  });

  app.get("/api/external-products", async (req, res) => {
    try {
      const response = await fetch("https://dummyjson.com/products?limit=5");
      const data = await response.json();

      return res.json({
        ok: true,
        products: data.products,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: "Failed to fetch external data" });
    }
  });

  app.use(resolvedSessionMiddleware);

  app.post("/builds", requireAuth, async (req, res) => {
    const {
      totalPrice = null,
      compatible = true,
      parts = {},
    } = req.body ?? {};

    if (!parts || typeof parts !== "object" || Array.isArray(parts)) {
      return res.status(400).json({ ok: false, error: "parts must be an object" });
    }

    const requestedParts = Object.values(parts).filter((part) => part && typeof part === "object");

    if (requestedParts.length === 0) {
      return res.status(400).json({ ok: false, error: "at least one part is required" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const buildResult = await client.query(
        `INSERT INTO builds (uid, price, validated)
         VALUES ($1, $2, $3)
         RETURNING build_id, uid, price, validated`,
        [req.session.userId, totalPrice, compatible]
      );
      const build = buildResult.rows[0];
      const partRows = [];

      for (const part of requestedParts) {
        let partResult;

        if (Number.isInteger(Number(part.sku)) && Number(part.sku) > 0) {
          partResult = await client.query(
            `SELECT sku, type, price, name, inventory
               FROM pc_parts
              WHERE sku = $1`,
            [Number(part.sku)]
          );
        } else if (typeof part.name === "string" && part.name.trim()) {
          partResult = await client.query(
            `SELECT sku, type, price, name, inventory
               FROM pc_parts
              WHERE name = $1`,
            [part.name.trim()]
          );
        } else {
          continue;
        }

        if (partResult.rows.length === 0) {
          continue;
        }

        const matchedPart = partResult.rows[0];
        partRows.push(matchedPart);

        await client.query(
          `INSERT INTO build_pc_parts (build_id, sku)
           VALUES ($1, $2)`,
          [build.build_id, matchedPart.sku]
        );
      }

      if (partRows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: "parts must reference existing pc_parts rows",
        });
      }

      await client.query("COMMIT");

      return res.json({ ok: true, build: buildSavedBuildResponse(build, partRows) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(error);
      return res.status(500).json({ ok: false, error: "Server error" });
    } finally {
      client.release();
    }
  });

  app.get("/builds/mine", requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           b.build_id,
           b.uid,
           b.price,
           b.validated,
           COALESCE(
             json_agg(
               json_build_object(
                 'sku', p.sku,
                 'type', p.type,
                 'price', p.price,
                 'name', p.name,
                 'inventory', p.inventory
               )
               ORDER BY bp.junction_id
             ) FILTER (WHERE p.sku IS NOT NULL),
             '[]'::json
           ) AS part_rows
         FROM builds b
         LEFT JOIN build_pc_parts bp ON bp.build_id = b.build_id
         LEFT JOIN pc_parts p ON p.sku = bp.sku
         WHERE b.uid = $1
         GROUP BY b.build_id, b.uid, b.price, b.validated
         ORDER BY b.build_id DESC`,
        [req.session.userId]
      );

      return res.json({ ok: true, builds: rows.map(normalizeSavedBuildRow) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.delete("/builds/:buildId", requireAuth, async (req, res) => {
    const buildId = Number(req.params.buildId);

    if (!Number.isInteger(buildId) || buildId <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid build id" });
    }

    try {
      const { rowCount } = await pool.query(
        `DELETE FROM builds
          WHERE build_id = $1 AND uid = $2`,
        [buildId, req.session.userId]
      );

      if (rowCount === 0) {
        return res.status(404).json({ ok: false, error: "Build not found" });
      }

      return res.json({ ok: true });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.post("/auth/register", async (req, res) => {
    const { email, password, username } = req.body ?? {};

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email/password required" });
    }

    if (password.length < 10) {
      return res.status(400).json({
        ok: false,
        error: "Password needs to be at least length of 10.",
      });
    }

    const normalizedEmail = typeof email === "string" ? email.toLowerCase() : null;
    const passwordHash = await bcryptLib.hash(password, 12);

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const userResult = await client.query(
          `
            INSERT INTO users (username, email)
            VALUES ($1, $2)
              RETURNING uid, username, email
          `,
          [username ?? null, normalizedEmail]
      );

      const user = userResult.rows[0];

      const authResult = await client.query(
          `
      INSERT INTO auth (uid, password_hash)
      VALUES ($1, $2)
      RETURNING auth_id
      `,
          [user.uid, passwordHash]
      );

      const auth = authResult.rows[0];

      await client.query("COMMIT");

      req.session.userId = Number(user.uid);

      await safeLogAuthEvent({
        userId: user.uid,
        attemptedEmail: user.email,
        eventType: "register",
        success: true,
        ipAddress: getClientIp(req),
        userAgent: req.get("user-agent") ?? null,
      });

      return res.json({
        ok: true,
        user: {
          id: Number(user.uid),
          email: user.email,
        },
      });
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}

      if (e.code === "23505") {
        await safeLogAuthEvent({
          attemptedEmail: normalizedEmail,
          eventType: "register",
          success: false,
          failureReason: "email_exists",
          ipAddress: getClientIp(req),
          userAgent: req.get("user-agent") ?? null,
        });

        return res.status(409).json({ ok: false, error: "Email already exists" });
      }

      await safeLogAuthEvent({
        attemptedEmail: normalizedEmail,
        eventType: "register",
        success: false,
        failureReason: "server_error",
        ipAddress: getClientIp(req),
        userAgent: req.get("user-agent") ?? null,
      });

      console.error(e);
      return res.status(500).json({ ok: false, error: "Server error" });
    } finally {
      client.release();
    }
  });

  app.post("/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body ?? {};
      const normalizedEmail = typeof email === "string" ? email.toLowerCase() : null;

      if (!email || !password) {
        await safeLogAuthEvent({
          attemptedEmail: normalizedEmail,
          eventType: "login",
          success: false,
          failureReason: "missing_credentials",
          ipAddress: getClientIp(req),
          userAgent: req.get("user-agent") ?? null,
        });

        return res
            .status(400)
            .json({ ok: false, error: "email/password required" });
      }

      const { rows } = await pool.query(
          `
      SELECT
        u.uid,
        u.username,
        u.email,
        a.auth_id,
        a.password_hash,
        a.account_lock,
        a.two_fa
      FROM users u
      JOIN auth a ON u.uid = a.uid
      WHERE u.email = $1
      `,
          [normalizedEmail]
      );

      if (rows.length === 0) {
        await safeLogAuthEvent({
          attemptedEmail: normalizedEmail,
          eventType: "login",
          success: false,
          failureReason: "invalid_credentials",
          ipAddress: getClientIp(req),
          userAgent: req.get("user-agent") ?? null,
        });

        return res.status(401).json({ ok: false, error: "Invalid credentials" });
      }

      const user = rows[0];
      //const ok = await resolvedBcrypt.compare(password, user.password_hash);

      if (user.account_lock) {
        await safeLogAuthEvent({
          userId: user.uid,
          attemptedEmail: user.email,
          eventType: "login",
          success: false,
          failureReason: "account_locked",
          ipAddress: getClientIp(req),
          userAgent: req.get("user-agent") ?? null,
        });

        return res.status(403).json({ ok: false, error: "Account locked" });
      }

      const ok = await bcryptLib.compare(password, user.password_hash);

      if (!ok) {
        await safeLogAuthEvent({
          userId: user.uid,
          attemptedEmail: user.email,
          eventType: "login",
          success: false,
          failureReason: "invalid_credentials",
          ipAddress: getClientIp(req),
          userAgent: req.get("user-agent") ?? null,
        });

        return res.status(401).json({ ok: false, error: "Invalid credentials" });
      }

      req.session.userId = Number(user.uid);

      await safeLogAuthEvent({
        userId: user.uid,
        attemptedEmail: user.email,
        eventType: "login",
        success: true,
        ipAddress: getClientIp(req),
        userAgent: req.get("user-agent") ?? null,
      });

      return res.json({
        ok: true,
        user: {
          id: Number(user.uid),
          email: user.email,
        },
      });
    } catch (e) {
      await safeLogAuthEvent({
        attemptedEmail:
            typeof req.body?.email === "string" ? req.body.email.toLowerCase() : null,
        eventType: "login",
        success: false,
        failureReason: "server_error",
        ipAddress: getClientIp(req),
        userAgent: req.get("user-agent") ?? null,
      });

      console.error(e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.get("/auth/me", requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT uid, email FROM users WHERE uid = $1",
        [req.session.userId]
      );
      return res.json({
        ok: true,
        user: {
          id: Number(rows[0].uid),
          email: rows[0].email,
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.post("/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ ok: false, error: "Logout failed" });

      res.clearCookie(SESSION_COOKIE_NAME);
      return res.json({ ok: true });
    });
  });

  app.patch("/auth/email", requireAuth, async (req, res) => {
    const { currentPassword, newEmail } = req.body ?? {};

    if (!currentPassword || !newEmail) {
      return res.status(400).json({ ok: false, error: "currentPassword and newEmail are required" });
    }

    const normalizedEmail = newEmail.toLowerCase().trim();

    try {
      const { rows } = await pool.query(
        "SELECT users.uid, users.email, auth.password_hash FROM users JOIN auth ON auth.uid = users.uid WHERE users.uid = $1",
        [req.session.userId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      const user = rows[0];
      const passwordMatch = await bcrypt.compare(currentPassword, user.password_hash);

      if (!passwordMatch) {
        return res.status(401).json({ ok: false, error: "Incorrect password" });
      }

      if (normalizedEmail === user.email) {
        return res.status(400).json({ ok: false, error: "New email is the same as current email" });
      }

      await pool.query("UPDATE users SET email = $1 WHERE uid = $2", [normalizedEmail, req.session.userId]);

      return res.json({ ok: true, user: { id: Number(user.uid), email: normalizedEmail } });
    } catch (e) {
      if (e.code === "23505") {
        return res.status(409).json({ ok: false, error: "Email already in use" });
      }
      console.error(e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.patch("/auth/password", requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: "currentPassword and newPassword are required" });
    }

    if (newPassword.length < 10) {
      return res.status(400).json({ ok: false, error: "New password must be at least 10 characters" });
    }

    try {
      const { rows } = await pool.query(
        "SELECT auth.auth_id, auth.password_hash FROM auth WHERE auth.uid = $1",
        [req.session.userId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      const authRow = rows[0];
      const passwordMatch = await bcrypt.compare(currentPassword, authRow.password_hash);

      if (!passwordMatch) {
        return res.status(401).json({ ok: false, error: "Incorrect current password" });
      }

      const newHash = await bcrypt.hash(newPassword, 12);
      await pool.query("UPDATE auth SET password_hash = $1 WHERE auth_id = $2", [newHash, authRow.auth_id]);

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.delete("/auth/account", requireAuth, async (req, res) => {
    const { currentPassword } = req.body ?? {};

    if (!currentPassword) {
      return res.status(400).json({ ok: false, error: "currentPassword is required" });
    }

    try {
      const { rows } = await pool.query(
        "SELECT auth.auth_id, auth.password_hash FROM auth WHERE auth.uid = $1",
        [req.session.userId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      const authRow = rows[0];
      const passwordMatch = await bcrypt.compare(currentPassword, authRow.password_hash);

      if (!passwordMatch) {
        return res.status(401).json({ ok: false, error: "Incorrect password" });
      }

      await pool.query("DELETE FROM users WHERE uid = $1", [req.session.userId]);

      req.session.destroy(() => {
        res.clearCookie(SESSION_COOKIE_NAME);
        return res.json({ ok: true });
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.get("/auth/logs", requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
          "SELECT uid, email FROM users WHERE uid = $1",
          [req.session.userId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      const logs = await resolvedAuthLogger.getRecentEventsForUser({
        userId: req.session.userId,
      });

      return res.json({ ok: true, logs });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.get("/health", async (req, res) => {
    try {
      const r = await pool.query("SELECT 1 as ok");
      res.json({ ok: true, db: r.rows[0].ok });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: "db down" });
    }
  });

  return app;
}

export function startServer({
  port = process.env.PORT ?? 3001,
  pool = createPool(),
  sessionMiddleware,
  bcryptLib = bcrypt,
  bcryptImpl,
  authLogger,
  sessionSecret = process.env.SESSION_SECRET,
  sessionStore,
} = {}) {


  const app = createApp({
    pool,
    sessionMiddleware:
      sessionMiddleware ?? createSessionMiddleware(pool, sessionSecret, sessionStore),
    bcryptLib,
    bcryptImpl,
    authLogger: authLogger ?? createAuthLogger(pool),
    sessionSecret,
    sessionStore,
  });

  return app.listen(port, () => {
    console.log(`Listening on ${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
