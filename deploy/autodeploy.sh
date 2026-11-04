#!/bin/bash
# Runs every minute (wc-autodeploy.timer): when main on GitHub has a new
# commit, deploys it. Log: /var/log/wc-autodeploy.log
cd /opt/wc-creative/app || exit 1
exec 9>/run/wc-autodeploy.lock
flock -n 9 || exit 0
git fetch -q origin main || exit 0
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
if /opt/wc-creative/deploy.sh >> /var/log/wc-autodeploy.log 2>&1; then
  echo "$(date -Is) deployed $(git rev-parse --short HEAD)" >> /var/log/wc-autodeploy.log
else
  echo "$(date -Is) deploy FAILED at $(git rev-parse --short origin/main)" >> /var/log/wc-autodeploy.log
fi
