#!/bin/bash

# 开发环境 Docker 启动脚本

set -e

echo "🚀 启动开发环境..."
echo ""

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "❌ 错误: .env 文件不存在"
    echo "请先复制 .env.example 并配置环境变量"
    exit 1
fi

# 创建必要的目录
mkdir -p voltagent-data logs

# 停止并删除旧容器（如果存在）
echo "🧹 清理旧容器..."
docker-compose -f docker-compose.dev.yml down 2>/dev/null || true

# 构建镜像
echo ""
echo "🔨 构建开发镜像..."
docker-compose -f docker-compose.dev.yml build

# 启动容器
echo ""
echo "▶️  启动容器..."
docker-compose -f docker-compose.dev.yml up -d

# 等待容器启动
echo ""
echo "⏳ 等待容器启动..."
sleep 3

# 显示日志
echo ""
echo "📋 容器日志 (Ctrl+C 退出日志查看，容器继续运行):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker-compose -f docker-compose.dev.yml logs -f
