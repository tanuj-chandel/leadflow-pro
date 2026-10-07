# 🌐 VPS Deployment Guide — LeadFlow Pro

This guide walks you through deploying **LeadFlow Pro** to an Ubuntu / Debian VPS (e.g. Hostinger, DigitalOcean, Hetzner, AWS EC2, Linode).

---

## 📋 Recommended VPS Specs
- **OS:** Ubuntu 22.04 LTS or 24.04 LTS
- **RAM:** Minimum 2 GB (4 GB recommended for Chromium / Puppeteer)
- **CPU:** 1-2 vCPU cores
- **Disk:** 20 GB+ SSD

---

## 🚀 Option 1: 1-Click Deployment with Docker Compose (Recommended)

Docker is the cleanest method because Chromium, Node, and all dependencies run in an isolated container without needing manual system configurations.

### 1. Install Docker & Docker Compose on your VPS
SSH into your VPS and run:
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```
*(Log out and log back into SSH so docker group takes effect)*

### 2. Upload Code to VPS
You can upload via `git clone` or SCP/SFTP:
```bash
git clone <YOUR_GIT_REPO_URL> ~/leadflow
cd ~/leadflow
```
Or upload via SCP from your local machine:
```bash
scp -r "d:\AI AUTOMATION\map_lead_scraper_redesigned" user@your-vps-ip:~/leadflow
```

### 3. Create Persistent Files
```bash
cd ~/leadflow
touch leads.db
mkdir -p .wwebjs_auth
```

### 4. Build and Start the Application
```bash
docker compose up -d --build
```

### 5. Check Live Logs
```bash
docker compose logs -f
```
Your app is now running at `http://YOUR_VPS_IP:3000`!

---

## ⚡ Option 2: Native Ubuntu Deployment with PM2 (Without Docker)

If you prefer running Node.js directly on the VPS host:

### 1. Install Node.js 20 & Build Essentials
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3
```

### 2. Install Chromium for WhatsApp Web
```bash
sudo apt install -y chromium-browser fonts-freefont-ttf libxss1
```

### 3. Install PM2 (Process Manager)
```bash
sudo npm install -g pm2
```

### 4. Install Project Dependencies & Start
```bash
cd ~/leadflow
npm install
pm2 start server.js --name "leadflow-pro"
pm2 save
pm2 startup
```

---

## 🔒 Optional: Setup Domain & Free SSL with Nginx + Certbot

To access via `https://leads.yourdomain.com`:

### 1. Install Nginx & Certbot
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2. Configure Nginx Reverse Proxy
Edit `/etc/nginx/sites-available/leadflow`:
```nginx
server {
    server_name leads.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # Needed for Server-Sent Events (SSE) live logs
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
    }
}
```

### 3. Enable Site & Generate SSL Certificate
```bash
sudo ln -s /etc/nginx/sites-available/leadflow /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d leads.yourdomain.com
```

---

## 💡 WhatsApp Session Persistence Note
* Your WhatsApp authentication is stored in `.wwebjs_auth/`.
* As long as you keep `.wwebjs_auth/` mounted (handled automatically in `docker-compose.yml`), you do **NOT** need to rescan the QR code when you restart or update the server!
