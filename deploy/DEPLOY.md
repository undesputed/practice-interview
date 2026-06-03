# EC2 Deployment

> Local dev needs none of this — `localhost` is a secure context, so camera/mic work over plain HTTP.
> This is only for remote testing on EC2, where browsers require HTTPS.

## 1. Provision
- Ubuntu 22.04 EC2 instance.
- Security group inbound: 443 (HTTPS), 22 (SSH).

## 2. App setup
```bash
sudo apt update && sudo apt install -y python3-venv nginx
git clone <your-repo> interview && cd interview
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt
printf "DEEPGRAM_API_KEY=...\nANTHROPIC_API_KEY=...\n" > .env
```

## 3. Run the app (systemd)
Create `/etc/systemd/system/interview.service`:
```ini
[Unit]
Description=Interview app
After=network.target
[Service]
WorkingDirectory=/home/ubuntu/interview
ExecStart=/home/ubuntu/interview/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000
Restart=always
EnvironmentFile=/home/ubuntu/interview/.env
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now interview
```

## 4. TLS (self-signed for testing)
```bash
sudo mkdir -p /etc/ssl/interview
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /etc/ssl/interview/key.pem -out /etc/ssl/interview/cert.pem -subj "/CN=$(curl -s ifconfig.me)"
sudo cp deploy/nginx.conf /etc/nginx/sites-available/interview
sudo ln -sf /etc/nginx/sites-available/interview /etc/nginx/sites-enabled/interview
sudo nginx -t && sudo systemctl restart nginx
```
Visit `https://<ec2-public-ip>/` and accept the one-time browser warning.
For a real cert, point a domain at the instance and use Let's Encrypt (`certbot --nginx`).
