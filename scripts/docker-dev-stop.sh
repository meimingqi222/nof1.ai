#!/bin/bash

# 开发环境 Docker 停止脚本

set -e

echo "🛑 停止开发环境..."
docker-compose -f docker-compose.dev.yml down

echo "✅ 开发环境已停止"
