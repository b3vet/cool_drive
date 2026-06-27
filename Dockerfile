# CoolDrive — static site served by nginx.
# nginx handles MP3 range-streaming, correct MIME types, gzip, and caching.
# Coolify auto-detects this Dockerfile; expose port 80.
FROM nginx:alpine

# our server config replaces the default site
COPY nginx.conf /etc/nginx/conf.d/default.conf

# the game (only what the browser needs — no dev/build files)
COPY index.html /usr/share/nginx/html/index.html
COPY src        /usr/share/nginx/html/src
COPY audio      /usr/share/nginx/html/audio
COPY models     /usr/share/nginx/html/models

EXPOSE 80
