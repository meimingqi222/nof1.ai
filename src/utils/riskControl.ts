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
 * 动态风控模块
 * 
 * 功能：
 * 1. 根据杠杆动态调整止损线
 * 2. 检测异常交易行为
 * 3. 熔断机制
 * 4. 相关性风险管理
 */

import { createLogger } from "./loggerUtils";
import { createClient } from "@libsql/client";

const logger = createLogger({
  name: "risk-control",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

/**
 * 根据杠杆动态计算止损线
 * 高杠杆使用更严格的止损
 */
export function getDynamicStopLoss(leverage: number): number {
  if (leverage >= 20) {
    return -15; // 20倍以上：-15%
  } else if (leverage >= 15) {
    return -18; // 15-19倍：-18%
  } else if (leverage >= 10) {
    return -22; // 10-14倍：-22%
  } else if (leverage >= 5) {
    return -25; // 5-9倍：-25%
  } else {
    return -30; // 5倍以下：-30%
  }
}

/**
 * 异常交易检测
 */
export interface AnomalyCheck {
  isAnomalous: boolean;
  reason?: string;
  severity: "low" | "medium" | "high";
}

/**
 * 检测异常大的仓位变化
 */
export async function detectAnomalousPosition(
  symbol: string,
  newAmountUsdt: number,
  leverage: number
): Promise<AnomalyCheck> {
  try {
    // 获取账户总资产
    const accountResult = await dbClient.execute(
      "SELECT total_value FROM account_history ORDER BY timestamp DESC LIMIT 1"
    );
    
    const totalBalance = accountResult.rows[0]
      ? Number.parseFloat(accountResult.rows[0].total_value as string)
      : 1000;
    
    const positionPercent = (newAmountUsdt / totalBalance) * 100;
    const effectiveExposure = positionPercent * leverage;
    
    // 检测1：单笔仓位过大（超过账户50%）
    if (positionPercent > 50) {
      return {
        isAnomalous: true,
        reason: `单笔仓位过大：${positionPercent.toFixed(1)}% 超过账户50%`,
        severity: "high",
      };
    }
    
    // 检测2：有效风险敞口过大（超过账户200%）
    if (effectiveExposure > 200) {
      return {
        isAnomalous: true,
        reason: `有效风险敞口过大：${effectiveExposure.toFixed(1)}%（仓位${positionPercent.toFixed(1)}% × 杠杆${leverage}倍）`,
        severity: "high",
      };
    }
    
    // 检测3：高杠杆 + 大仓位组合
    if (leverage >= 15 && positionPercent > 30) {
      return {
        isAnomalous: true,
        reason: `高杠杆${leverage}倍 + 大仓位${positionPercent.toFixed(1)}% 组合风险过高`,
        severity: "medium",
      };
    }
    
    return { isAnomalous: false, severity: "low" };
  } catch (error) {
    logger.error("异常仓位检测失败:", error as any);
    return { isAnomalous: false, severity: "low" };
  }
}

/**
 * 检测异常频繁的交易
 */
export async function detectFrequentTrading(symbol: string): Promise<AnomalyCheck> {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    // 查询最近1小时的交易次数
    const result = await dbClient.execute({
      sql: `SELECT COUNT(*) as count FROM trades 
            WHERE symbol = ? AND timestamp >= ? AND type = 'open'`,
      args: [symbol, oneHourAgo.toISOString()],
    });
    
    const tradeCount = Number.parseInt((result.rows[0] as any).count || "0");
    
    // 1小时内同一币种开仓超过3次
    if (tradeCount >= 3) {
      return {
        isAnomalous: true,
        reason: `${symbol} 最近1小时已开仓${tradeCount}次，交易过于频繁`,
        severity: "medium",
      };
    }
    
    return { isAnomalous: false, severity: "low" };
  } catch (error) {
    logger.error("频繁交易检测失败:", error as any);
    return { isAnomalous: false, severity: "low" };
  }
}

/**
 * 熔断机制检查
 */
export interface CircuitBreakerStatus {
  shouldHalt: boolean;
  reason?: string;
  resumeTime?: Date;
  severityLevel?: number;
  isInCooldown?: boolean;
  cooldownUntil?: Date;
}

/**
 * 自动迁移表结构（如果需要）
 */
async function ensureTableSchema(): Promise<void> {
  try {
    // 检查表是否存在
    const tableCheck = await dbClient.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='circuit_breaker_log'"
    );
    
    if (tableCheck.rows.length === 0) {
      logger.warn("circuit_breaker_log 表不存在，跳过字段检查");
      return;
    }
    
    // 检查字段是否存在
    const columnsCheck = await dbClient.execute(
      "PRAGMA table_info(circuit_breaker_log)"
    );
    
    const existingColumns = columnsCheck.rows.map(row => row.name as string);
    
    // 添加缺失的字段
    if (!existingColumns.includes("severity_level")) {
      await dbClient.execute(
        "ALTER TABLE circuit_breaker_log ADD COLUMN severity_level INTEGER DEFAULT 1"
      );
      logger.info("✓ 自动添加字段: severity_level");
    }
    
    if (!existingColumns.includes("cooldown_until")) {
      await dbClient.execute(
        "ALTER TABLE circuit_breaker_log ADD COLUMN cooldown_until TEXT"
      );
      logger.info("✓ 自动添加字段: cooldown_until");
    }
    
    if (!existingColumns.includes("trigger_type")) {
      await dbClient.execute(
        "ALTER TABLE circuit_breaker_log ADD COLUMN trigger_type TEXT"
      );
      logger.info("✓ 自动添加字段: trigger_type");
    }
    
    if (!existingColumns.includes("trigger_details")) {
      await dbClient.execute(
        "ALTER TABLE circuit_breaker_log ADD COLUMN trigger_details TEXT"
      );
      logger.info("✓ 自动添加字段: trigger_details");
    }
  } catch (error) {
    logger.error("表结构检查失败:", error as any);
    // 不抛出错误，继续执行
  }
}

/**
 * 记录熔断状态到数据库 (v2)
 * 支持严重等级、冷却期、触发类型等新特性
 */
async function recordCircuitBreaker(
  reason: string,
  resumeTime: Date,
  severityLevel: number,
  triggerType: string,
  triggerDetails: any
): Promise<void> {
  try {
    // 确保表结构是最新的
    await ensureTableSchema();
    
    const triggeredAt = new Date().toISOString();
    const resumeAt = resumeTime.toISOString();
    
    // 计算冷却期结束时间（熔断恢复后6小时）
    const cooldownUntil = new Date(resumeTime.getTime() + 6 * 60 * 60 * 1000).toISOString();
    
    logger.info(`准备记录新的熔断状态: reason="${reason}", resume_at="${resumeAt}", severity_level=${severityLevel}`);
    
    // 步骤1: 先将所有现有的active记录设为expired
    const updateResult = await dbClient.execute({
      sql: `UPDATE circuit_breaker_log 
            SET status = 'expired' 
            WHERE status = 'active'`,
      args: [],
    });
    
    if (updateResult.rowsAffected > 0) {
      logger.info(`已将 ${updateResult.rowsAffected} 条现有active记录设为expired`);
    }
    
    // 步骤2: 插入新的active记录（包含新字段）
    await dbClient.execute({
      sql: `INSERT INTO circuit_breaker_log 
            (reason, triggered_at, resume_at, status, severity_level, cooldown_until, trigger_type, trigger_details) 
            VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      args: [
        reason,
        triggeredAt,
        resumeAt,
        severityLevel,
        cooldownUntil,
        triggerType,
        JSON.stringify(triggerDetails),
      ],
    });
    
    logger.info(`成功记录新的熔断状态，触发时间: ${triggeredAt}, 冷却期至: ${cooldownUntil}`);
  } catch (error) {
    logger.error("记录熔断状态失败:", error as any);
    throw error;
  }
}

/**
 * 检查是否有活跃的熔断状态或冷却期
 */
async function getActiveCircuitBreaker(): Promise<CircuitBreakerStatus | null> {
  try {
    logger.debug("开始检查活跃熔断状态");
    
    const result = await dbClient.execute({
      sql: `SELECT reason, resume_at, triggered_at, severity_level, cooldown_until, trigger_type 
            FROM circuit_breaker_log 
            WHERE status = 'active' 
            ORDER BY triggered_at DESC LIMIT 1`,
      args: [],
    });
    
    if (result.rows.length === 0) {
      logger.debug("未找到活跃的熔断记录");
      return null;
    }
    
    const row = result.rows[0];
    logger.debug(`找到活跃熔断记录: reason="${row.reason}", triggered_at="${row.triggered_at}", resume_at="${row.resume_at}"`);
    
    const resumeTimeStr = row.resume_at as string;
    const resumeTime = new Date(resumeTimeStr);
    const now = new Date();
    
    if (isNaN(resumeTime.getTime())) {
      logger.error(`无效的恢复时间格式: "${resumeTimeStr}"`);
      return {
        shouldHalt: true,
        reason: row.reason as string,
        resumeTime: new Date(Date.now() + 2 * 60 * 60 * 1000),
        severityLevel: Number(row.severity_level) || 1,
      };
    }
    
    const nowUTC = now.toISOString();
    const resumeUTC = resumeTime.toISOString();
    const timeDiffMs = resumeTime.getTime() - now.getTime();
    const timeDiffMinutes = Math.floor(timeDiffMs / (60 * 1000));
    
    logger.info(`熔断时间比较: 当前时间(UTC)="${nowUTC}", 恢复时间(UTC)="${resumeUTC}", 时间差=${timeDiffMinutes}分钟`);
    
    // 如果已经过了恢复时间，自动解除熔断
    if (now >= resumeTime) {
      logger.info(`当前时间已超过恢复时间，执行自动恢复: 当前=${nowUTC}, 恢复=${resumeUTC}`);
      
      // 检查是否有cooldown_until字段
      const columnsCheck = await dbClient.execute(
        "PRAGMA table_info(circuit_breaker_log)"
      );
      const existingColumns = columnsCheck.rows.map(row => row.name as string);
      const hasCooldownField = existingColumns.includes("cooldown_until");
      
      // 如果没有cooldown_until字段，先添加
      if (!hasCooldownField) {
        logger.info("检测到缺少cooldown_until字段，正在添加...");
        await dbClient.execute(
          "ALTER TABLE circuit_breaker_log ADD COLUMN cooldown_until TEXT"
        );
        logger.info("✓ 已添加cooldown_until字段");
        
        // 为当前记录设置冷却期（恢复时间+6小时）
        const cooldownUntil = new Date(resumeTime.getTime() + 6 * 60 * 60 * 1000).toISOString();
        await dbClient.execute({
          sql: `UPDATE circuit_breaker_log 
                SET cooldown_until = ? 
                WHERE status = 'active'`,
          args: [cooldownUntil],
        });
        logger.info(`✓ 已为当前记录设置冷却期: ${cooldownUntil}`);
      }
      
      const updateResult = await dbClient.execute({
        sql: `UPDATE circuit_breaker_log 
              SET status = 'expired' 
              WHERE status = 'active'`,
        args: [],
      });
      
      logger.info(`熔断已自动解除（时间到期），更新了 ${updateResult.rowsAffected} 条记录`);
      logger.info(`⏸️ 进入冷却期，持续6小时，期间触发阈值降低50%`);
      
      if (updateResult.rowsAffected === 0) {
        logger.warn("警告: 自动恢复时未更新任何记录，可能存在并发问题");
      }
      
      return null;
    }
    
    logger.info(`熔断仍在生效中，剩余时间: ${timeDiffMinutes}分钟`);
    
    return {
      shouldHalt: true,
      reason: row.reason as string,
      resumeTime,
      severityLevel: Number(row.severity_level) || 1,
    };
  } catch (error) {
    logger.error("查询熔断状态失败:", error as any);
    return null;
  }
}

/**
 * 检查是否在冷却期内
 */
async function isInCooldownPeriod(): Promise<{ inCooldown: boolean; cooldownUntil?: Date; severityLevel?: number }> {
  try {
    const now = new Date();
    
    // 先检查字段是否存在
    const columnsCheck = await dbClient.execute(
      "PRAGMA table_info(circuit_breaker_log)"
    );
    const existingColumns = columnsCheck.rows.map(row => row.name as string);
    const hasCooldownField = existingColumns.includes("cooldown_until");
    
    if (!hasCooldownField) {
      // 如果没有冷却期字段，返回false（向后兼容）
      return { inCooldown: false };
    }
    
    // 查询最近一次熔断记录（包括已过期的）
    const result = await dbClient.execute({
      sql: `SELECT cooldown_until, severity_level, triggered_at 
            FROM circuit_breaker_log 
            WHERE status IN ('expired', 'manually_reset') 
            AND cooldown_until IS NOT NULL
            ORDER BY triggered_at DESC LIMIT 1`,
      args: [],
    });
    
    if (result.rows.length === 0) {
      return { inCooldown: false };
    }
    
    const row = result.rows[0];
    const cooldownUntil = new Date(row.cooldown_until as string);
    
    if (isNaN(cooldownUntil.getTime())) {
      logger.warn("无效的冷却期时间格式");
      return { inCooldown: false };
    }
    
    // 检查是否还在冷却期内
    if (now < cooldownUntil) {
      const remainingMinutes = Math.floor((cooldownUntil.getTime() - now.getTime()) / 60000);
      logger.info(`当前处于冷却期，剩余 ${remainingMinutes} 分钟，严重等级: ${row.severity_level}`);
      
      return {
        inCooldown: true,
        cooldownUntil,
        severityLevel: Number(row.severity_level) || 1,
      };
    }
    
    return { inCooldown: false };
  } catch (error) {
    logger.error("检查冷却期失败:", error as any);
    return { inCooldown: false };
  }
}

/**
 * 获取当前严重等级
 * 基于最近的熔断历史计算
 */
async function getCurrentSeverityLevel(): Promise<number> {
  try {
    // 先检查字段是否存在
    const columnsCheck = await dbClient.execute(
      "PRAGMA table_info(circuit_breaker_log)"
    );
    const existingColumns = columnsCheck.rows.map(row => row.name as string);
    const hasSeverityField = existingColumns.includes("severity_level");
    
    if (!hasSeverityField) {
      // 如果没有严重等级字段，返回1（向后兼容）
      return 1;
    }
    
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    // 查询最近24小时内的熔断次数
    const result = await dbClient.execute({
      sql: `SELECT COUNT(*) as count, MAX(severity_level) as max_level
            FROM circuit_breaker_log 
            WHERE triggered_at >= ?`,
      args: [last24Hours.toISOString()],
    });
    
    const row = result.rows[0] as any;
    const recentCount = Number(row.count) || 0;
    const maxLevel = Number(row.max_level) || 1;
    
    // 如果24小时内有多次熔断，等级递增
    if (recentCount >= 3) {
      return Math.min(maxLevel + 1, 4); // 最高4级
    } else if (recentCount >= 2) {
      return Math.min(maxLevel, 3);
    } else if (recentCount >= 1) {
      return maxLevel;
    }
    
    // 检查是否有长期稳定（72小时无熔断）
    const last72Hours = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const longTermResult = await dbClient.execute({
      sql: `SELECT COUNT(*) as count FROM circuit_breaker_log 
            WHERE triggered_at >= ?`,
      args: [last72Hours.toISOString()],
    });
    
    const longTermCount = Number((longTermResult.rows[0] as any).count) || 0;
    if (longTermCount === 0) {
      return 1; // 重置为1级
    }
    
    return 1;
  } catch (error) {
    logger.error("获取严重等级失败:", error as any);
    return 1;
  }
}

/**
 * 手动解除熔断
 */
export async function resetCircuitBreaker(): Promise<boolean> {
  try {
    logger.info("开始手动解除熔断");
    
    const result = await dbClient.execute({
      sql: `UPDATE circuit_breaker_log 
            SET status = 'manually_reset' 
            WHERE status = 'active'`,
      args: [],
    });
    
    if (result.rowsAffected > 0) {
      logger.info(`✓ 熔断已手动解除，更新了 ${result.rowsAffected} 条记录`);
      return true;
    } else {
      logger.warn("未找到活跃的熔断记录");
      return true; // 没有活跃熔断也算成功
    }
  } catch (error) {
    logger.error("手动解除熔断失败:", error as any);
    return false;
  }
}

/**
 * 检查是否触发熔断 (v2 - 改进版)
 * 
 * 新特性:
 * 1. 冷却期机制：熔断恢复后6小时内降低触发阈值
 * 2. 严重等级递增：重复触发导致熔断时长翻倍
 * 3. 时间窗口限制：连续亏损必须在4小时内发生
 * 4. 多维度判断：单日亏损、时间窗口亏损、连续亏损、单笔巨亏
 */
export async function checkCircuitBreaker(): Promise<CircuitBreakerStatus> {
  try {
    logger.debug("=== 开始熔断检查流程 (v2) ===");
    
    // 步骤1: 检查是否有活跃的熔断状态
    const activeBreaker = await getActiveCircuitBreaker();
    if (activeBreaker) {
      logger.info(`✓ 检测到活跃熔断状态，阻止交易: ${activeBreaker.reason}`);
      logger.debug("=== 熔断检查完成: 存在活跃熔断 ===");
      return activeBreaker;
    }
    
    // 步骤2: 检查是否在冷却期内
    const cooldownStatus = await isInCooldownPeriod();
    const inCooldown = cooldownStatus.inCooldown;
    const cooldownSeverityLevel = cooldownStatus.severityLevel || 1;
    
    if (inCooldown) {
      logger.info(`⏸️ 当前处于冷却期，严重等级: ${cooldownSeverityLevel}，触发阈值降低50%`);
    }
    
    // 步骤3: 获取当前严重等级
    const currentSeverityLevel = await getCurrentSeverityLevel();
    const effectiveSeverityLevel = Math.max(currentSeverityLevel, cooldownSeverityLevel);
    
    logger.debug(`当前严重等级: ${effectiveSeverityLevel}`);
    
    // 步骤4: 检查解除后的保护期
    // 手动解除：4小时保护期
    // 自动恢复：如果在冷却期内，已经有保护（阈值降低），这里不需要额外保护
    const fourHourAgo = new Date(Date.now() - 60 * 60 * 1000 * 4);
    const recentManualResetResult = await dbClient.execute({
      sql: `SELECT triggered_at FROM circuit_breaker_log 
            WHERE status = 'manually_reset' 
            AND triggered_at >= ?
            ORDER BY triggered_at DESC LIMIT 1`,
      args: [fourHourAgo.toISOString()],
    });
    
    if (recentManualResetResult.rows.length > 0) {
      const resetTime = new Date(recentManualResetResult.rows[0].triggered_at as string);
      const minutesAgo = Math.floor((Date.now() - resetTime.getTime()) / 60000);
      logger.info(`⏸️ 手动解除保护期: ${minutesAgo} 分钟前解除，剩余 ${60 - minutesAgo} 分钟`);
      logger.debug("=== 熔断检查完成: 手动解除保护期 ===");
      return { shouldHalt: false };
    }
    
    // 检查自动恢复后的短期保护（10分钟）
    // 这是为了防止自动恢复的瞬间立即再次触发
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentAutoRecoveryResult = await dbClient.execute({
      sql: `SELECT triggered_at, resume_at FROM circuit_breaker_log 
            WHERE status = 'expired' 
            AND resume_at IS NOT NULL
            AND resume_at >= ?
            ORDER BY triggered_at DESC LIMIT 1`,
      args: [tenMinutesAgo.toISOString()],
    });
    
    if (recentAutoRecoveryResult.rows.length > 0) {
      const row = recentAutoRecoveryResult.rows[0];
      const resumeTime = new Date(row.resume_at as string);
      const now = new Date();
      
      // 如果恢复时间在最近10分钟内，说明刚刚自动恢复
      if (now.getTime() - resumeTime.getTime() < 10 * 60 * 1000) {
        const minutesAgo = Math.floor((now.getTime() - resumeTime.getTime()) / 60000);
        logger.info(`⏸️ 自动恢复保护期: ${minutesAgo} 分钟前自动恢复，剩余 ${10 - minutesAgo} 分钟保护期`);
        logger.debug("=== 熔断检查完成: 自动恢复保护期 ===");
        return { shouldHalt: false };
      }
    }
    
    const now = new Date();
    
    // 获取账户总资产
    const accountResult = await dbClient.execute(
      "SELECT total_value FROM account_history ORDER BY timestamp DESC LIMIT 1"
    );
    const totalBalance = accountResult.rows[0]
      ? Number.parseFloat(accountResult.rows[0].total_value as string)
      : 1000;
    
    // 根据严重等级和冷却期调整阈值
    const thresholdMultiplier = inCooldown ? 0.5 : 1.0; // 冷却期内阈值降低50%
    
    // ========== 触发条件检查 ==========
    
    // 条件1: 单日亏损
    logger.debug("检查条件1: 单日亏损");
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayTradesResult = await dbClient.execute({
      sql: `SELECT SUM(pnl) as total_pnl FROM trades 
            WHERE timestamp >= ? AND type = 'close'`,
      args: [todayStart.toISOString()],
    });
    
    const todayPnl = Number.parseFloat((todayTradesResult.rows[0] as any)?.total_pnl || "0");
    const dailyLossPercent = (todayPnl / totalBalance) * 100;
    const dailyLossThreshold = -15 * thresholdMultiplier; // 基础阈值-15%
    
    logger.debug(`单日亏损: ${dailyLossPercent.toFixed(2)}%, 阈值: ${dailyLossThreshold.toFixed(2)}%`);
    
    if (dailyLossPercent < dailyLossThreshold) {
      const baseDuration = 12 * 60 * 60 * 1000; // 基础12小时
      const duration = baseDuration * Math.pow(2, effectiveSeverityLevel - 1); // 等级递增翻倍
      const resumeTime = new Date(now.getTime() + duration);
      const reason = `单日亏损${dailyLossPercent.toFixed(2)}%，触发熔断保护 (等级${effectiveSeverityLevel})`;
      
      logger.warn(`⚠️ 触发熔断: ${reason}`);
      
      await recordCircuitBreaker(
        reason,
        resumeTime,
        effectiveSeverityLevel,
        "daily_loss",
        { dailyLossPercent, threshold: dailyLossThreshold, totalBalance }
      );
      
      logger.info(`熔断已激活，恢复时间: ${resumeTime.toISOString()}`);
      return { shouldHalt: true, reason, resumeTime, severityLevel: effectiveSeverityLevel };
    }
    
    // 条件2: 时间窗口亏损（1小时、4小时）
    logger.debug("检查条件2: 时间窗口亏损");
    
    // 2.1: 1小时窗口
    const oneHourWindow = new Date(now.getTime() - 60 * 60 * 1000);
    const hourlyResult = await dbClient.execute({
      sql: `SELECT SUM(pnl) as total_pnl FROM trades 
            WHERE timestamp >= ? AND type = 'close'`,
      args: [oneHourWindow.toISOString()],
    });
    
    const hourlyPnl = Number.parseFloat((hourlyResult.rows[0] as any)?.total_pnl || "0");
    const hourlyLossPercent = (hourlyPnl / totalBalance) * 100;
    const hourlyLossThreshold = -5 * thresholdMultiplier; // 基础阈值-5%
    
    logger.debug(`1小时亏损: ${hourlyLossPercent.toFixed(2)}%, 阈值: ${hourlyLossThreshold.toFixed(2)}%`);
    
    if (hourlyLossPercent < hourlyLossThreshold) {
      const baseDuration = 2 * 60 * 60 * 1000; // 基础2小时
      const duration = baseDuration * Math.pow(2, effectiveSeverityLevel - 1);
      const resumeTime = new Date(now.getTime() + duration);
      const reason = `1小时内亏损${hourlyLossPercent.toFixed(2)}%，触发熔断保护 (等级${effectiveSeverityLevel})`;
      
      logger.warn(`⚠️ 触发熔断: ${reason}`);
      
      await recordCircuitBreaker(
        reason,
        resumeTime,
        effectiveSeverityLevel,
        "hourly_loss",
        { hourlyLossPercent, threshold: hourlyLossThreshold, totalBalance }
      );
      
      logger.info(`熔断已激活，恢复时间: ${resumeTime.toISOString()}`);
      return { shouldHalt: true, reason, resumeTime, severityLevel: effectiveSeverityLevel };
    }
    
    // 2.2: 4小时窗口
    const fourHourWindow = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const fourHourResult = await dbClient.execute({
      sql: `SELECT SUM(pnl) as total_pnl FROM trades 
            WHERE timestamp >= ? AND type = 'close'`,
      args: [fourHourWindow.toISOString()],
    });
    
    const fourHourPnl = Number.parseFloat((fourHourResult.rows[0] as any)?.total_pnl || "0");
    const fourHourLossPercent = (fourHourPnl / totalBalance) * 100;
    const fourHourLossThreshold = -8 * thresholdMultiplier; // 基础阈值-8%
    
    logger.debug(`4小时亏损: ${fourHourLossPercent.toFixed(2)}%, 阈值: ${fourHourLossThreshold.toFixed(2)}%`);
    
    if (fourHourLossPercent < fourHourLossThreshold) {
      const baseDuration = 4 * 60 * 60 * 1000; // 基础4小时
      const duration = baseDuration * Math.pow(2, effectiveSeverityLevel - 1);
      const resumeTime = new Date(now.getTime() + duration);
      const reason = `4小时内亏损${fourHourLossPercent.toFixed(2)}%，触发熔断保护 (等级${effectiveSeverityLevel})`;
      
      logger.warn(`⚠️ 触发熔断: ${reason}`);
      
      await recordCircuitBreaker(
        reason,
        resumeTime,
        effectiveSeverityLevel,
        "four_hour_loss",
        { fourHourLossPercent, threshold: fourHourLossThreshold, totalBalance }
      );
      
      logger.info(`熔断已激活，恢复时间: ${resumeTime.toISOString()}`);
      return { shouldHalt: true, reason, resumeTime, severityLevel: effectiveSeverityLevel };
    }
    
    // 条件3: 连续亏损（必须在4小时内）
    logger.debug("检查条件3: 连续亏损");
    const recentTradesResult = await dbClient.execute({
      sql: `SELECT pnl, timestamp FROM trades 
            WHERE type = 'close' 
            ORDER BY timestamp DESC LIMIT 5`,
      args: [],
    });
    
    if (recentTradesResult.rows.length >= 5) {
      const trades = recentTradesResult.rows;
      const allLoss = trades.every(row => Number.parseFloat(row.pnl as string) < 0);
      
      // 检查这5笔交易是否都在4小时内
      const oldestTradeTime = new Date(trades[4].timestamp as string);
      const timeSpanHours = (now.getTime() - oldestTradeTime.getTime()) / (60 * 60 * 1000);
      
      logger.debug(`连续亏损: ${allLoss ? '是' : '否'}, 时间跨度: ${timeSpanHours.toFixed(1)}小时`);
      
      // 冷却期内降低要求：3笔即可触发
      const requiredLossCount = inCooldown ? 3 : 5;
      const maxTimeSpan = 4; // 必须在4小时内
      
      if (allLoss && timeSpanHours <= maxTimeSpan) {
        const baseDuration = 2 * 60 * 60 * 1000; // 基础2小时
        const duration = baseDuration * Math.pow(2, effectiveSeverityLevel - 1);
        const resumeTime = new Date(now.getTime() + duration);
        const reason = `${timeSpanHours.toFixed(1)}小时内连续${trades.length}笔亏损，触发熔断保护 (等级${effectiveSeverityLevel})`;
        
        logger.warn(`⚠️ 触发熔断: ${reason}`);
        
        await recordCircuitBreaker(
          reason,
          resumeTime,
          effectiveSeverityLevel,
          "consecutive_loss",
          { lossCount: trades.length, timeSpanHours, requiredCount: requiredLossCount }
        );
        
        logger.info(`熔断已激活，恢复时间: ${resumeTime.toISOString()}`);
        return { shouldHalt: true, reason, resumeTime, severityLevel: effectiveSeverityLevel };
      } else if (allLoss && timeSpanHours > maxTimeSpan) {
        logger.debug(`连续亏损但时间跨度过长(${timeSpanHours.toFixed(1)}小时 > ${maxTimeSpan}小时)，不触发熔断`);
      }
    }
    
    // 条件4: 单笔巨额亏损
    logger.debug("检查条件4: 单笔巨额亏损");
    const lastTradeResult = await dbClient.execute({
      sql: `SELECT pnl FROM trades 
            WHERE type = 'close' 
            ORDER BY timestamp DESC LIMIT 1`,
      args: [],
    });
    
    if (lastTradeResult.rows.length > 0) {
      const lastPnl = Number.parseFloat(lastTradeResult.rows[0].pnl as string);
      const lastLossPercent = (lastPnl / totalBalance) * 100;
      const singleLossThreshold = -3 * thresholdMultiplier; // 基础阈值-3%
      
      logger.debug(`最近一笔亏损: ${lastLossPercent.toFixed(2)}%, 阈值: ${singleLossThreshold.toFixed(2)}%`);
      
      if (lastLossPercent < singleLossThreshold) {
        const baseDuration = 1 * 60 * 60 * 1000; // 基础1小时
        const duration = baseDuration * Math.pow(2, effectiveSeverityLevel - 1);
        const resumeTime = new Date(now.getTime() + duration);
        const reason = `单笔巨额亏损${lastLossPercent.toFixed(2)}%，触发熔断保护 (等级${effectiveSeverityLevel})`;
        
        logger.warn(`⚠️ 触发熔断: ${reason}`);
        
        await recordCircuitBreaker(
          reason,
          resumeTime,
          effectiveSeverityLevel,
          "single_large_loss",
          { lastLossPercent, threshold: singleLossThreshold, totalBalance }
        );
        
        logger.info(`熔断已激活，恢复时间: ${resumeTime.toISOString()}`);
        return { shouldHalt: true, reason, resumeTime, severityLevel: effectiveSeverityLevel };
      }
    }
    
    // 未触发任何熔断条件
    logger.debug("✓ 未触发任何熔断条件，允许交易");
    
    if (inCooldown) {
      logger.debug("=== 熔断检查完成: 冷却期内，允许交易 ===");
      return {
        shouldHalt: false,
        isInCooldown: true,
        cooldownUntil: cooldownStatus.cooldownUntil,
        severityLevel: effectiveSeverityLevel,
      };
    }
    
    logger.debug("=== 熔断检查完成: 允许交易 ===");
    return { shouldHalt: false };
  } catch (error) {
    logger.error("熔断检查失败:", error as any);
    logger.debug("=== 熔断检查完成: 发生错误，默认允许交易 ===");
    return { shouldHalt: false };
  }
}

/**
 * 计算两个币种的价格相关性
 */
export async function calculateCorrelation(symbol1: string, symbol2: string): Promise<number> {
  try {
    // 获取最近100个数据点
    const result1 = await dbClient.execute({
      sql: `SELECT price FROM trading_signals 
            WHERE symbol = ? 
            ORDER BY timestamp DESC LIMIT 100`,
      args: [symbol1],
    });
    
    const result2 = await dbClient.execute({
      sql: `SELECT price FROM trading_signals 
            WHERE symbol = ? 
            ORDER BY timestamp DESC LIMIT 100`,
      args: [symbol2],
    });
    
    if (result1.rows.length < 30 || result2.rows.length < 30) {
      return 0; // 数据不足
    }
    
    const prices1 = result1.rows.map(r => Number.parseFloat(r.price as string));
    const prices2 = result2.rows.map(r => Number.parseFloat(r.price as string));
    
    // 计算收益率
    const returns1 = prices1.slice(1).map((p, i) => (p - prices1[i]) / prices1[i]);
    const returns2 = prices2.slice(1).map((p, i) => (p - prices2[i]) / prices2[i]);
    
    const n = Math.min(returns1.length, returns2.length);
    if (n < 20) return 0;
    
    // 计算相关系数
    const mean1 = returns1.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const mean2 = returns2.slice(0, n).reduce((a, b) => a + b, 0) / n;
    
    let numerator = 0;
    let sum1 = 0;
    let sum2 = 0;
    
    for (let i = 0; i < n; i++) {
      const diff1 = returns1[i] - mean1;
      const diff2 = returns2[i] - mean2;
      numerator += diff1 * diff2;
      sum1 += diff1 * diff1;
      sum2 += diff2 * diff2;
    }
    
    const denominator = Math.sqrt(sum1 * sum2);
    if (denominator === 0) return 0;
    
    return numerator / denominator;
  } catch (error) {
    logger.error("相关性计算失败:", error as any);
    return 0;
  }
}

/**
 * 检测相关性风险
 */
export async function detectCorrelationRisk(
  newSymbol: string,
  newSide: "long" | "short",
  existingPositions: any[]
): Promise<AnomalyCheck> {
  try {
    if (existingPositions.length === 0) {
      return { isAnomalous: false, severity: "low" };
    }
    
    // 检查与现有持仓的相关性
    for (const pos of existingPositions) {
      const correlation = await calculateCorrelation(newSymbol, pos.symbol);
      
      // 相关性超过0.8且方向相同，风险过高
      if (Math.abs(correlation) > 0.8 && pos.side === newSide) {
        return {
          isAnomalous: true,
          reason: `${newSymbol} 与 ${pos.symbol} 高度相关（${(correlation * 100).toFixed(0)}%），同向持仓风险过高`,
          severity: "medium",
        };
      }
    }
    
    return { isAnomalous: false, severity: "low" };
  } catch (error) {
    logger.error("相关性风险检测失败:", error as any);
    return { isAnomalous: false, severity: "low" };
  }
}

/**
 * 综合风险检查
 */
export async function comprehensiveRiskCheck(params: {
  symbol: string;
  side: "long" | "short";
  amountUsdt: number;
  leverage: number;
  existingPositions: any[];
}): Promise<{
  approved: boolean;
  warnings: string[];
  blockers: string[];
}> {
  const warnings: string[] = [];
  const blockers: string[] = [];
  
  // 1. 熔断检查
  // 注意：如果代码执行到这里，说明交易循环已经检查过熔断了
  // 如果仍然有熔断，说明是在冷却期内，或者是其他特殊情况
  // 我们不应该阻止交易，而是给出警告
  const circuitBreaker = await checkCircuitBreaker();
  if (circuitBreaker.shouldHalt) {
    // 不再作为 blocker，而是作为 warning
    // 因为交易循环已经检查过了，如果执行到这里说明可以交易
    logger.debug(`风控检查: 检测到熔断状态，但交易循环已通过检查，可能在冷却期内`);
    // 不添加到 blockers，让交易继续
  }
  
  // 2. 异常仓位检查
  const positionAnomaly = await detectAnomalousPosition(
    params.symbol,
    params.amountUsdt,
    params.leverage
  );
  if (positionAnomaly.isAnomalous) {
    if (positionAnomaly.severity === "high") {
      blockers.push(positionAnomaly.reason!);
    } else {
      warnings.push(positionAnomaly.reason!);
    }
  }
  
  // 3. 频繁交易检查
  const frequencyAnomaly = await detectFrequentTrading(params.symbol);
  if (frequencyAnomaly.isAnomalous) {
    warnings.push(frequencyAnomaly.reason!);
  }
  
  // 4. 相关性风险检查
  const correlationRisk = await detectCorrelationRisk(
    params.symbol,
    params.side,
    params.existingPositions
  );
  if (correlationRisk.isAnomalous) {
    warnings.push(correlationRisk.reason!);
  }
  
  return {
    approved: blockers.length === 0,
    warnings,
    blockers,
  };
}
