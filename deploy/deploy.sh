#!/bin/bash
# Pulls the latest code, builds the site and restarts the media server.
set -e
cd /opt/wc-creative/app
git pull -q --ff-only
npm ci --silent
cp /opt/wc-creative/.env .env
npm run build
rm -rf /var/www/creative.woodencrew.com.new
cp -r dist /var/www/creative.woodencrew.com.new
rm -rf /var/www/creative.woodencrew.com
mv /var/www/creative.woodencrew.com.new /var/www/creative.woodencrew.com
mkdir -p /var/lib/wc-creative/media
chown -R www-data:www-data /var/lib/wc-creative
cp deploy/wc-media.service /etc/systemd/system/wc-media.service
systemctl daemon-reload
systemctl enable -q wc-media
systemctl restart wc-media
echo DEPLOYED
