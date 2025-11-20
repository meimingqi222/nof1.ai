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
}

/**
 * 记录熔断状态到数据库
 * 在插入新记录前先将现有active记录设为expired，确保同时只有一条active状态的记录
 */
async function recordCircuitBreaker(reason: string, resumeTime: Date): Promise<void> {
  try {
    const triggeredAt = new Date().toISOString();
    const resumeAt = resumeTime.toISOString();
    
    logger.info(`准备记录新的熔断状态: reason="${reason}", resume_at="${resumeAt}"`);
    
    // 使用事务处理保证原子性
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
    
    // 步骤2: 插入新的active记录
    await dbClient.execute({
      sql: `INSERT INTO circuit_breaker_log (reason, triggered_at, resume_at, status) 
            VALUES (?, ?, ?, 'active')`,
      args: [reason, triggeredAt, resumeAt],
    });
    
    logger.info(`成功记录新的熔断状态，触发时间: ${triggeredAt}`);
  } catch (error) {
    logger.error("记录熔断状态失败:", error as any);
    throw error; // 重新抛出错误，让调用方知道操作失败
  }
}

/**
 * 检查是否有活跃的熔断状态
 */
async function getActiveCircuitBreaker(): Promise<CircuitBreakerStatus | null> {
  try {
    logger.debug("开始检查活跃熔断状态");
    
    const result = await dbClient.execute({
      sql: `SELECT reason, resume_at, triggered_at FROM circuit_breaker_log 
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
    
    // 使用UTC时间进行比较，避免时区问题
    const resumeTimeStr = row.resume_at as string;
    const resumeTime = new Date(resumeTimeStr);
    const now = new Date();
    
    // 验证时间解析是否成功
    if (isNaN(resumeTime.getTime())) {
      logger.error(`无效的恢复时间格式: "${resumeTimeStr}"`);
      return {
        shouldHalt: true,
        reason: row.reason as string,
        resumeTime: new Date(Date.now() + 2 * 60 * 60 * 1000), // 默认2小时后
      };
    }
    
    // 记录详细的时间比较信息
    const nowUTC = now.toISOString();
    const resumeUTC = resumeTime.toISOString();
    const timeDiffMs = resumeTime.getTime() - now.getTime();
    const timeDiffMinutes = Math.floor(timeDiffMs / (60 * 1000));
    
    logger.info(`熔断时间比较: 当前时间(UTC)="${nowUTC}", 恢复时间(UTC)="${resumeUTC}", 时间差=${timeDiffMinutes}分钟`);
    
    // 如果已经过了恢复时间，自动解除熔断
    if (now >= resumeTime) {
      logger.info(`当前时间已超过恢复时间，执行自动恢复: 当前=${nowUTC}, 恢复=${resumeUTC}`);
      
      const updateResult = await dbClient.execute({
        sql: `UPDATE circuit_breaker_log 
              SET status = 'expired' 
              WHERE status = 'active'`,
        args: [],
      });
      
      logger.info(`熔断已自动解除（时间到期），更新了 ${updateResult.rowsAffected} 条记录`);
      
      // 验证更新是否成功
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
    };
  } catch (error) {
    logger.error("查询熔断状态失败:", error as any);
    return null;
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
 * 检查是否触发熔断
 * 
 * 执行流程:
 * 1. 首先检查是否存在活跃的熔断状态
 * 2. 如果存在活跃熔断，直接返回该状态（阻止交易）
 * 3. 如果不存在活跃熔断，才检查是否需要触发新的熔断条件
 * 4. 确保历史熔断记录（expired/manually_reset）不会影响新交易判断
 */
export async function checkCircuitBreaker(): Promise<CircuitBreakerStatus> {
  try {
    logger.debug("=== 开始熔断检查流程 ===");
    
    // 步骤1: 首先检查是否有活跃的熔断状态
    // getActiveCircuitBreaker() 内部会自动处理过期的熔断（将其状态更新为expired）
    // 只有状态为'active'的记录才会被返回
    const activeBreaker = await getActiveCircuitBreaker();
    
    if (activeBreaker) {
      // 存在活跃熔断，直接返回，阻止新交易
      logger.info(`✓ 检测到活跃熔断状态，阻止交易: ${activeBreaker.reason}`);
      logger.debug("=== 熔断检查完成: 存在活跃熔断 ===");
      return activeBreaker;
    }
    
    // 步骤2: 无活跃熔断，检查是否需要触发新的熔断
    // 注意: 此时所有历史熔断记录的状态都不是'active'，因此不会影响判断
    logger.debug("✓ 无活跃熔断，开始检查新的触发条件");
    
    // 步骤2.1: 检查是否刚刚手动解除过熔断（冷却期机制）
    // 如果在过去1小时内手动解除过熔断，则不再触发新的熔断（给用户一个操作窗口）
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentManualResetResult = await dbClient.execute({
      sql: `SELECT id, reason, triggered_at FROM circuit_breaker_log 
            WHERE status = 'manually_reset' 
            AND triggered_at >= ?
            ORDER BY triggered_at DESC LIMIT 1`,
      args: [oneHourAgo.toISOString()],
    });
    
    if (recentManualResetResult.rows.length > 0) {
      const recentReset = recentManualResetResult.rows[0];
      const resetTime = new Date(recentReset.triggered_at as string);
      const minutesAgo = Math.floor((Date.now() - resetTime.getTime()) / 60000);
      logger.info(`⏸️ 检测到 ${minutesAgo} 分钟前手动解除过熔断: "${recentReset.reason}"`);
      logger.info(`冷却期保护: 1小时内不再触发新的熔断，剩余 ${60 - minutesAgo} 分钟`);
      logger.debug("=== 熔断检查完成: 冷却期保护中 ===");
      return { shouldHalt: false };
    }
    
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // 检查条件1: 单日亏损
    logger.debug("检查触发条件1: 单日亏损是否超过10%");
    const todayTradesResult = await dbClient.execute({
      sql: `SELECT SUM(pnl) as total_pnl FROM trades 
            WHERE timestamp >= ? AND type = 'close'`,
      args: [todayStart.toISOString()],
    });
    
    const todayPnl = Number.parseFloat((todayTradesResult.rows[0] as any)?.total_pnl || "0");
    
    // 获取账户总资产
    const accountResult = await dbClient.execute(
      "SELECT total_value FROM account_history ORDER BY timestamp DESC LIMIT 1"
    );
    
    const totalBalance = accountResult.rows[0]
      ? Number.parseFloat(accountResult.rows[0].total_value as string)
      : 1000;
    
    const dailyLossPercent = (todayPnl / totalBalance) * 100;
    logger.debug(`单日PnL: ${todayPnl.toFixed(2)} USDT, 账户总值: ${totalBalance.toFixed(2)} USDT, 亏损比例: ${dailyLossPercent.toFixed(2)}%`);
    
    // 单日亏损超过10%触发熔断
    if (dailyLossPercent < -10) {
      const resumeTime = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
      const reason = `单日亏损${dailyLossPercent.toFixed(2)}%，触发熔断保护`;
      logger.warn(`⚠️ 触发新熔断: ${reason}`);
      
      // 记录新的熔断状态（recordCircuitBreaker会自动处理旧的active记录）
      await recordCircuitBreaker(reason, resumeTime);
      logger.info(`熔断已激活，预计恢复时间: ${resumeTime.toISOString()}`);
      logger.debug("=== 熔断检查完成: 触发新熔断（单日亏损） ===");
      
      return {
        shouldHalt: true,
        reason,
        resumeTime,
      };
    }
    
    // 检查条件2: 连续亏损
    logger.debug("检查触发条件2: 是否连续5笔交易亏损");
    const recentTradesResult = await dbClient.execute({
      sql: `SELECT pnl FROM trades 
            WHERE type = 'close' 
            ORDER BY timestamp DESC LIMIT 5`,
      args: [],
    });
    
    const recentTradesCount = recentTradesResult.rows.length;
    logger.debug(`最近平仓交易数量: ${recentTradesCount}`);
    
    if (recentTradesCount >= 5) {
      const allLoss = recentTradesResult.rows.every(
        row => Number.parseFloat(row.pnl as string) < 0
      );
      
      logger.debug(`连续亏损检查: ${allLoss ? '是' : '否'}（最近5笔交易${allLoss ? '全部' : '不全'}亏损）`);
      
      if (allLoss) {
        const resumeTime = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2小时后恢复
        const reason = "连续5笔交易亏损，触发熔断保护";
        logger.warn(`⚠️ 触发新熔断: ${reason}`);
        
        // 记录新的熔断状态（recordCircuitBreaker会自动处理旧的active记录）
        await recordCircuitBreaker(reason, resumeTime);
        logger.info(`熔断已激活，预计恢复时间: ${resumeTime.toISOString()}`);
        logger.debug("=== 熔断检查完成: 触发新熔断（连续亏损） ===");
        
        return {
          shouldHalt: true,
          reason,
          resumeTime,
        };
      }
    } else {
      logger.debug(`连续亏损检查: 跳过（交易数量不足5笔）`);
    }
    
    // 步骤3: 无活跃熔断且未触发新熔断条件，允许交易
    logger.debug("✓ 未触发任何熔断条件，允许交易");
    logger.debug("=== 熔断检查完成: 允许交易 ===");
    
    return { shouldHalt: false };
  } catch (error) {
    logger.error("熔断检查失败:", error as any);
    // 发生错误时，为安全起见不阻止交易，但记录错误
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
