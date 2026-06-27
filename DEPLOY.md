# Deploying CoolDrive with Coolify

CoolDrive is a static site (HTML + JS modules + assets, no build step). This repo
ships a **Dockerfile** that serves it with nginx — handling MP3 range-streaming,
correct MIME types, gzip, and caching. Coolify builds that image and gives you
HTTPS + a domain automatically, so you don't need Cloudflare or any extra config.

## Prerequisites
- Coolify already installed on your VPS ✅
- This project in a Git repo Coolify can reach (GitHub / GitLab / Gitea / Bitbucket,
  or a self-hosted Git). **Include the `audio/` folder with your MP3s.**

## Steps
1. **Push the code** to a Git repo (with `audio/*.mp3` committed).
2. In Coolify: **+ New → Application**.
3. **Source:** select your Git provider and the repo + branch (e.g. `main`).
4. **Build Pack:** choose **Dockerfile** (Coolify auto-detects the `Dockerfile` at the repo root).
5. **Port:** set the exposed/container port to **80** (nginx listens on 80).
6. **Domain:** add your domain (e.g. `cooldrive.yourdomain.com`) and point that
   subdomain's DNS **A record** at your VPS IP. Coolify's built-in proxy (Traefik)
   issues a free Let's Encrypt TLS cert automatically.
7. **Deploy.** Coolify builds the image and starts the container — open your domain.

## Updating
Push to the branch, then click **Redeploy** in Coolify (or enable **Auto Deploy** so
each push redeploys via webhook).

## What the container does
- nginx serves the static files from `/usr/share/nginx/html`.
- **MP3 range requests** (seeking/streaming) work out of the box.
- gzip for JS/CSS/JSON/SVG; long cache for `audio/`, `models/`, images; `no-cache`
  for HTML/JS so updates appear immediately.
- three.js + es-module-shims load from the jsDelivr CDN over HTTPS (no mixed content).

## Audio
Your songs are served straight from your VPS by nginx — exactly what you want for a
self-hosted setup. No CORS or special config needed. If traffic ever grows you can
front the domain with Cloudflare later for edge caching (optional, no code change).

## Alternative: no Git
Prefer not to use Git? Build and push the image yourself, then in Coolify create a
resource from a **Docker Image**:
```bash
docker build -t registry.example.com/cooldrive:latest .
docker push registry.example.com/cooldrive:latest
```
Then in Coolify: **+ New → Docker Image**, point at that image, port **80**, add domain, deploy.

## Test the production image locally (optional)
```bash
docker build -t cooldrive .
docker run --rm -p 8080:80 cooldrive
# open http://localhost:8080
```
