#!/bin/sh
# Собирает готовый воркер для вставки в Cloudflare: платёжная часть + основной воркер
cd "$(dirname "$0")" && cat atom-access.js proxy-main.js > atom-proxy-full.js && echo "Готово: worker/atom-proxy-full.js"
