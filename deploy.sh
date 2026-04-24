#!/bin/bash
# GPT-Image-2 Server 一键部署脚本
# 在服务器上运行: bash deploy.sh

set -e
APP_DIR="$HOME/gpt-image-server"
REPO="https://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@github.com/velist/gpt-image-server.git"

echo "=== GPT-Image-2 Server 部署 ==="

# 1. 检查 Node.js
if ! command -v node &>/dev/null; then
  echo "[1] 安装 Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[1] Node.js 已安装: $(node -v)"
fi

# 2. 克隆或更新代码
if [ -d "$APP_DIR" ]; then
  echo "[2] 更新代码..."
  cd "$APP_DIR" && git pull
else
  echo "[2] 克隆代码..."
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# 3. 安装依赖
echo "[3] 安装依赖..."
npm install --production

# 4. 创建 .env（如果不存在）
if [ ! -f .env ]; then
  cat > .env << 'ENVEOF'
UPSTREAM_API_BASE=https://api.duckcoding.ai/v1
UPSTREAM_API_KEY=sk-Hn40DCaAntDuXlUX9cnW1lpZfF9O6UKFgVfZjadjLSI9txfj
ADMIN_PASSWORD=gpt2024admin
JWT_SECRET=gpt-image-server-jwt-secret-change-me
PORT=3000
ENVEOF
  echo "[4] 已创建 .env（请修改 ADMIN_PASSWORD 和 JWT_SECRET）"
else
  echo "[4] .env 已存在，跳过"
fi

# 5. 安装 pm2
if ! command -v pm2 &>/dev/null; then
  echo "[5] 安装 pm2..."
  sudo npm install -g pm2
else
  echo "[5] pm2 已安装"
fi

# 6. 启动服务
echo "[6] 启动服务..."
pm2 delete gpt-image-server 2>/dev/null || true
pm2 start server.js --name gpt-image-server
pm2 save

echo ""
echo "=== 部署完成 ==="
echo "服务地址: http://localhost:3000"
echo "管理后台: http://localhost:3000/admin"
echo "管理密码: $(grep ADMIN_PASSWORD .env | cut -d= -f2)"
echo ""
echo "常用命令:"
echo "  pm2 logs gpt-image-server   # 查看日志"
echo "  pm2 restart gpt-image-server # 重启"
echo "  pm2 stop gpt-image-server    # 停止"
