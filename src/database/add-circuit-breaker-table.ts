/**
 * open-nof1.ai - AI 加密货币自动交易系统
 * Copyright (C) 2025 195440
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 添加熔断日志表的迁移脚本
 */

import { createClient } from "@libsql/client";

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

async function migrate() {
  try {
    console.log("开始添加熔断日志表...");
    
    await dbClient.execute(`
      CREATE TABLE IF NOT EXISTS circuit_breaker_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reason TEXT NOT NULL,
        triggered_at TEXT NOT NULL,
        resume_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `);
    
    await dbClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_circuit_breaker_status 
      ON circuit_breaker_log(status, triggered_at)
    `);
    
    console.log("✅ 熔断日志表添加成功");
  } catch (error) {
    console.error("❌ 迁移失败:", error);
    process.exit(1);
  }
}

migrate();
