#!/bin/sh

SPOOF_IP="$1"
DOMAIN="$2"

[ -z "$SPOOF_IP" ] && SPOOF_IP=$(uci -q get switch2-block.global.spoof_ip)
[ -z "$DOMAIN" ] && DOMAIN="ctest.p01.ctest.srv.nintendo.net"

echo "=== DNS_RESULT ==="
nslookup -type=A "$DOMAIN" "$SPOOF_IP" 2>&1

echo "=== HTTP_HEADER ==="
curl -s -i --noproxy '*' --connect-timeout 3 -m 5 -H "Host: $DOMAIN" "http://$SPOOF_IP" 2>&1 | tr -d '\r' | sed '/^$/q'

echo "=== HTTP_BODY_LEN ==="
curl -s --noproxy '*' --connect-timeout 3 -m 5 -H "Host: $DOMAIN" "http://$SPOOF_IP" 2>/dev/null | wc -c | tr -d ' \n'

echo ""
echo "=== HTTP_BODY ==="
curl -s --noproxy '*' --connect-timeout 3 -m 5 -H "Host: $DOMAIN" "http://$SPOOF_IP" 2>/dev/null
