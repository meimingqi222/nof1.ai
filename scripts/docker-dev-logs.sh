#!/bin/bash

# 开发环境 Docker 日志查看脚本

# 如果提供了行数参数，使用它；否则默认跟踪日志
if [ -n "$1" ]; then
    echo "📋 查看最近 $1 行日志..."
    docker-compose -f docker-compose.dev.yml logs --tail="$1"
else
    echo "📋 实时查看日志 (Ctrl+C 退出)..."
    docker-compose -f docker-compose.dev.yml logs -f
fi
