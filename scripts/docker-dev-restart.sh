#!/bin/bash

# 开发环境 Docker 重启脚本

set -e

echo "🔄 重启开发环境..."
docker-compose -f docker-compose.dev.yml restart

echo "✅ 开发环境已重启"
echo ""
echo "📋 查看日志:"
docker-compose -f docker-compose.dev.yml logs -f
