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
 * 数据质量检查模块
 * 
 * 功能：
 * 1. 验证市场数据新鲜度
 * 2. 检查数据完整性
 * 3. 检测异常数据
 */

import { createLogger } from "./loggerUtils";

const logger = createLogger({
  name: "data-quality",
  level: "info",
});

/**
 * 数据质量报告
 */
export interface DataQualityReport {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  timestamp: string;
}

/**
 * 检查K线数据新鲜度
 */
export function checkCandleFreshness(
  candles: any[],
  timeframe: string
): { isFresh: boolean; reason?: string } {
  if (!candles || candles.length === 0) {
    return { isFresh: false, reason: "K线数据为空" };
  }
  
  const latestCandle = candles[candles.length - 1];
  if (!latestCandle.t) {
    return { isFresh: false, reason: "K线缺少时间戳" };
  }
  
  const latestTime = Number.parseInt(latestCandle.t) * 1000; // 转换为毫秒
  const now = Date.now();
  const ageMinutes = (now - latestTime) / (1000 * 60);
  
  // 根据时间框架设置新鲜度阈值
  const thresholds: Record<string, number> = {
    "1m": 5,    // 1分钟K线，5分钟内
    "3m": 10,   // 3分钟K线，10分钟内
    "5m": 15,   // 5分钟K线，15分钟内
    "15m": 30,  // 15分钟K线，30分钟内
    "30m": 60,  // 30分钟K线，60分钟内
    "1h": 120,  // 1小时K线，120分钟内
  };
  
  const threshold = thresholds[timeframe] || 30;
  
  if (ageMinutes > threshold) {
    return {
      isFresh: false,
      reason: `${timeframe} K线数据过期（${ageMinutes.toFixed(1)}分钟前，阈值${threshold}分钟）`,
    };
  }
  
  return { isFresh: true };
}

/**
 * 检查价格数据有效性
 */
export function validatePriceData(price: number, symbol: string): { isValid: boolean; reason?: string } {
  if (!Number.isFinite(price)) {
    return { isValid: false, reason: `${symbol} 价格不是有效数字: ${price}` };
  }
  
  if (price <= 0) {
    return { isValid: false, reason: `${symbol} 价格必须大于0: ${price}` };
  }
  
  // 检查价格是否异常（与历史价格偏离过大）
  // 这里简化处理，实际应该与历史价格对比
  
  return { isValid: true };
}

/**
 * 检查技术指标有效性
 */
export function validateIndicators(indicators: any, symbol: string): DataQualityReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // 检查必需指标
  const requiredIndicators = ["ema20", "ema50", "macd", "rsi14", "volume"];
  
  for (const indicator of requiredIndicators) {
    const value = indicators[indicator];
    
    if (value === undefined || value === null) {
      errors.push(`${symbol} 缺少指标: ${indicator}`);
      continue;
    }
    
    if (!Number.isFinite(value)) {
      errors.push(`${symbol} 指标${indicator}不是有效数字: ${value}`);
      continue;
    }
  }
  
  // 检查RSI范围
  if (indicators.rsi14 !== undefined) {
    if (indicators.rsi14 < 0 || indicators.rsi14 > 100) {
      errors.push(`${symbol} RSI14超出范围[0,100]: ${indicators.rsi14}`);
    }
  }
  
  if (indicators.rsi7 !== undefined) {
    if (indicators.rsi7 < 0 || indicators.rsi7 > 100) {
      errors.push(`${symbol} RSI7超出范围[0,100]: ${indicators.rsi7}`);
    }
  }
  
  // 检查成交量
  if (indicators.volume !== undefined && indicators.volume < 0) {
    errors.push(`${symbol} 成交量不能为负: ${indicators.volume}`);
  }
  
  if (indicators.volume === 0) {
    warnings.push(`${symbol} 当前成交量为0，可能市场流动性不足`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 检查市场数据完整性
 */
export function validateMarketData(marketData: Record<string, any>): DataQualityReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  if (!marketData || Object.keys(marketData).length === 0) {
    errors.push("市场数据为空");
    return {
      isValid: false,
      errors,
      warnings,
      timestamp: new Date().toISOString(),
    };
  }
  
  for (const [symbol, data] of Object.entries(marketData)) {
    // 检查价格
    const priceCheck = validatePriceData(data.price, symbol);
    if (!priceCheck.isValid) {
      errors.push(priceCheck.reason!);
    }
    
    // 检查技术指标
    const indicatorCheck = validateIndicators(data, symbol);
    errors.push(...indicatorCheck.errors);
    warnings.push(...indicatorCheck.warnings);
    
    // 检查时间框架数据
    if (data.timeframes) {
      const timeframes = ["1m", "3m", "5m", "15m", "30m", "1h"];
      for (const tf of timeframes) {
        if (!data.timeframes[tf]) {
          warnings.push(`${symbol} 缺少${tf}时间框架数据`);
        }
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 检查账户数据有效性
 */
export function validateAccountData(accountInfo: any): DataQualityReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  if (!accountInfo) {
    errors.push("账户数据为空");
    return {
      isValid: false,
      errors,
      warnings,
      timestamp: new Date().toISOString(),
    };
  }
  
  // 检查必需字段
  const requiredFields = ["totalBalance", "availableBalance", "unrealisedPnl"];
  
  for (const field of requiredFields) {
    const value = accountInfo[field];
    
    if (value === undefined || value === null) {
      errors.push(`账户数据缺少字段: ${field}`);
      continue;
    }
    
    if (!Number.isFinite(value)) {
      errors.push(`账户字段${field}不是有效数字: ${value}`);
    }
  }
  
  // 检查余额合理性
  if (accountInfo.totalBalance < 0) {
    errors.push(`账户总资产不能为负: ${accountInfo.totalBalance}`);
  }
  
  if (accountInfo.availableBalance < 0) {
    warnings.push(`可用余额为负: ${accountInfo.availableBalance}，可能保证金不足`);
  }
  
  if (accountInfo.totalBalance === 0) {
    errors.push("账户总资产为0，无法交易");
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 综合数据质量检查
 */
export function comprehensiveDataCheck(params: {
  marketData: Record<string, any>;
  accountInfo: any;
  positions: any[];
}): DataQualityReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // 1. 检查市场数据
  const marketCheck = validateMarketData(params.marketData);
  errors.push(...marketCheck.errors);
  warnings.push(...marketCheck.warnings);
  
  // 2. 检查账户数据
  const accountCheck = validateAccountData(params.accountInfo);
  errors.push(...accountCheck.errors);
  warnings.push(...accountCheck.warnings);
  
  // 3. 检查持仓数据
  if (!Array.isArray(params.positions)) {
    errors.push("持仓数据不是数组");
  } else if (params.positions.length > 0) {
    // 只有在有持仓时才检查
    for (const pos of params.positions) {
      if (!pos.symbol) {
        errors.push("持仓缺少币种信息");
      }
      if (!pos.side || (pos.side !== "long" && pos.side !== "short")) {
        errors.push(`${pos.symbol || "未知"} 持仓方向无效: ${pos.side}`);
      }
      if (!Number.isFinite(pos.quantity) || pos.quantity <= 0) {
        errors.push(`${pos.symbol || "未知"} 持仓数量无效: ${pos.quantity}`);
      }
    }
  }
  
  // 4. 数据一致性检查
  const validSymbols = Object.keys(params.marketData).filter(
    symbol => params.marketData[symbol].price > 0
  );
  
  if (validSymbols.length === 0) {
    errors.push("没有有效的市场数据");
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    timestamp: new Date().toISOString(),
  };
}
