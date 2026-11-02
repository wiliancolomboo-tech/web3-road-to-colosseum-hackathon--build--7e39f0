cp .env.example .env
# Edit .env with DISCORD_WEBHOOK_URL and RESEND_API_KEY
docker-compose up -d --build
docker-compose logs -f aegisflow-worker