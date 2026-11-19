#!/bin/sh

# No caller-supplied host, URL or command: this probe contacts the local helper only.
[ "$#" -eq 0 ] || exit 1
export LC_ALL=C
. /lib/functions.sh
. /usr/libexec/switch2-block/domains.sh
umask 077
work=$(mktemp -d /tmp/switch2-test.XXXXXX) || exit 1
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM

probe_domain() {
	local domain="$1" ip="$2" code bad=0
	echo "DNS: $domain at $ip"
	if ! nslookup -type=A "$domain" "$ip" >"$work/dns" 2>&1 ||
	   ! awk -v ip="$ip" '
		/^Name:[[:space:]]/ {answer=1; next}
		answer && /^Address([[:space:]][0-9]+)?:[[:space:]]/ {
			sub(/^Address([[:space:]][0-9]+)?:[[:space:]]*/, "")
			if ($1 == ip) found=1; else bad=1
		}
		END {exit (!found || bad)}
	   ' "$work/dns"; then
		echo "Expected an A answer containing only the helper address."
		bad=1
	fi
	cat "$work/dns"

	echo "HTTP: $ip:80 (Host: $domain)"
	if code=$(curl -q --silent --show-error --noproxy '*' --connect-timeout 3 --max-time 5 \
		--max-filesize 4096 -H "Host: $domain" -o "$work/body" -w '%{http_code}' "http://$ip/") &&
	   [ "$code" = 200 ] && [ "$(wc -c < "$work/body")" -eq 2 ] && [ "$(cat "$work/body")" = ok ]; then
		echo "HTTP 200 with the exact two-byte body: ok"
	else
		echo "Unexpected HTTP status ($code) or body; expected HTTP 200 and two bytes: ok"
		bad=1
	fi
	return "$bad"
}

helper_check() {
	# Use a unique UCI package name so no staged delta can shadow the snapshot.
	local pkg="probe_${work##*.}" ip domains domain listeners bad=0
	cp /etc/config/switch2-block "$work/$pkg" || return 1
	UCI_CONFIG_DIR="$work" LOAD_STATE= config_load "$pkg" || {
		echo "Cannot read the committed Switch configuration."
		return 1
	}
	config_get ip global spoof_ip
	domains=$(switch2_test_domains) || { echo "Invalid Nintendo test domain list."; return 1; }
	if ! ip -4 addr show dev br-lan | awk -v ip="$ip" '$1 == "inet" {split($2, a, "/"); if (a[1] == ip) found=1} END {exit !found}'; then
		echo "Configured helper IPv4 address is not assigned to br-lan."
		return 1
	fi
	while IFS= read -r domain; do
		probe_domain "$domain" "$ip" || bad=1
	done <<EOF
$domains
EOF

	echo "Helper DNS and HTTP listeners:"
	listeners=$(netstat -lntup) || return 1
	printf '%s\n' "$listeners" | awk -v ip="$ip" -v pids="$work/dns-pids" '
		$1 ~ /^(tcp|udp)/ {
			addr=$4; port=addr; sub(/^.*:/, "", port); sub(/:[^:]*$/, "", addr)
			if (port != 53 && port != 80) next
			if (addr != ip && addr != "0.0.0.0" && addr != "*" && addr != "::" && addr != "[::]") next
			print
			if (addr != ip) bad=1
			else if (port == 80 && $1 == "tcp" && $NF ~ /^[0-9]+\/uhttpd$/) http=1
			else if (port == 53 && $NF ~ /^[0-9]+\/dnsmasq$/) {
				dns[$1]=1; split($NF, owner, "/"); print owner[1] > pids
			} else bad=1
		}
		END {if (bad || !http || !dns["tcp"] || !dns["udp"]) {
			print "Expected exclusive helper listeners on UDP/TCP 53 and TCP 80."; exit 1
		}}
	' || bad=1
	if [ -f "$work/dns-pids" ]; then
		while read -r pid; do
			if ! tr '\0' '\n' < "/proc/$pid/cmdline" | grep -Fxq /var/etc/dnsmasq.conf.nintendo_dns; then
				echo "DNS listener is not the isolated dnsmasq instance."
				bad=1
			fi
		done < "$work/dns-pids"
	fi
	return "$bad"
}

status=0
echo "Router-local helper checks:"
helper_check || status=1
echo
if /etc/init.d/switch2-guard enabled; then
	echo "Early boot isolation guard is enabled."
else
	echo "Early boot isolation guard is missing or not enabled."
	status=1
fi
echo
echo "Active isolation policy (committed configuration):"
if ! detail=$(/usr/libexec/switch2-block/policy.sh check 2>&1) || [ -z "$detail" ]; then
	status=1
fi
printf '%s\n' "$detail"
if [ "$status" -ne 0 ] || ! cmp -s /etc/config/switch2-block "$work/probe_${work##*.}"; then
	echo "Self-test failed or configuration changed during the check."
	exit 1
fi
echo "[switch2-block:complete]"
