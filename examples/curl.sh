#!/usr/bin/env bash
# Buffered and streaming requests using nothing but curl.
set -euo pipefail
: "${CSL_KEY:?set CSL_KEY to your csl_sk_... gateway key}"
URL="${CSL_URL:-http://127.0.0.1:3210}"

echo "--- buffered"
curl -s "$URL/v1/messages" \
  -H "x-api-key: $CSL_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 200,
    "messages": [{"role": "user", "content": "Name three uses for a paperclip. One line each."}]
  }'
echo

echo "--- streaming (raw SSE)"
curl -sN "$URL/v1/messages" \
  -H "x-api-key: $CSL_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 200,
    "stream": true,
    "messages": [{"role": "user", "content": "Count from 1 to 10."}]
  }'
