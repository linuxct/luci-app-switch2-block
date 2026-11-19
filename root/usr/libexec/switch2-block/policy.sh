#!/bin/sh
# apply/restore/check read committed settings only. Only explicit remove unblocks.
set -e
umask 077
export LC_ALL=C

store=/etc/switch2-block
snapshot=$store/policy.nft
table=switch2_block

fail() {
	printf 'Switch isolation: %s\n' "$*" >&2
	exit 1
}

case "${1-}" in apply|restore|check|remove) action=$1 ;; *) fail 'usage: policy.sh {apply|restore|check|remove}' ;; esac
[ "$#" -eq 1 ] || fail 'unexpected arguments'

# A file-descriptor lock survives neither process death nor reboot. Never unlink
# the lock file: another caller may already be waiting on its inode.
mkdir -p /var/lock
exec 9>>/var/lock/switch2-block-policy.lock
flock -x 9 || fail 'cannot lock policy'
work=$(mktemp -d /tmp/switch2-policy.XXXXXX)
staged=
trap 'rm -rf "$work"; [ -z "$staged" ] || rm -f "$staged"' EXIT
trap 'exit 1' HUP INT TERM

# add is idempotent. add/delete/recreate in ONE nft batch removes stale
# chains/sets/hooks as well as rules, without an interval with no protection.
reset_tables() {
	local family
	for family in inet bridge; do
		printf 'add table %s %s\ndelete table %s %s\n' "$family" "$table" "$family" "$table"
	done
}

install_policy() {
	reset_tables > "$work/transaction" || return 1
	cat "$1" >> "$work/transaction" || return 1
	nft -f "$work/transaction"
}

if [ "$action" = remove ]; then
	reset_tables > "$work/transaction"
	nft -f "$work/transaction" || fail 'could not remove the private nft tables'
	rm -f "$snapshot"
	sync
	printf 'Switch isolation removed.\n'
	exit 0
fi

restored=0
if [ "$action" = restore ] && [ -f "$snapshot" ]; then
	# Boot is gated by the caller. Reinstate the last successful policy even
	# if UCI/nft preflight or compilation of the new request subsequently fails.
	if install_policy "$snapshot"; then
		restored=1
	else
		printf 'Cannot restore saved policy; requiring valid committed replacement.\n' >&2
	fi
fi

. /lib/functions.sh
load_committed() {
	# libuci treats an absolute package path as a standalone file, with no
	# /tmp/.uci deltas. -P alone adds a path; it does not remove the default.
	uci -s -n export "/etc/config/$1" > "$work/config" || fail "cannot read committed $1 configuration"
	. "$work/config"
}

check_offload() (
	local section option value
	load_committed firewall
	for section in $CONFIG_SECTIONS; do
		config_get value "$section" TYPE
		[ "$value" = defaults ] || continue
		for option in flow_offloading flow_offloading_hw; do
			config_get value "$section" "$option" 0
			case "$value" in 0|no|false|off|disabled) ;; *) fail "disable firewall.$section.$option before enrolling any console" ;; esac
		done
	done
	# The running firewall may not reflect the committed configuration. Do
	# not flush flows/firewalls to mask that mismatch. Vendor acceleration
	# and external switch silicon cannot be certified from netfilter.
	nft list flowtables > "$work/flows" || fail 'cannot inspect running nft flowtables'
	if grep -Eq '^[[:space:]]*flowtable[[:space:]]' "$work/flows"; then
		fail 'active nft flowtable; disable acceleration and reboot before connecting the console'
	fi
	if [ -r /proc/net/nf_conntrack ] && grep -Eq '\[(HW_)?OFFLOAD\]' /proc/net/nf_conntrack; then
		fail 'offloaded connections still exist; disable acceleration and reboot'
	fi
)

valid_ipv4() {
	local addr="$1" IFS=. octet
	case "$addr" in ''|*[!0-9.]*) return 1 ;; esac
	set -- $addr
	[ "$#" = 4 ] && [ "$addr" = "$1.$2.$3.$4" ] || return 1
	for octet do
		case "$octet" in ''|0?*|????*) return 1 ;; esac
		[ "$octet" -le 255 ] || return 1
	done
	[ "$1" -gt 0 ] && [ "$1" -ne 127 ] && [ "$1" -lt 224 ]
}

collect_device() {
	local section="$1" mac block
	# Unlike config_get's default, '-' distinguishes missing from explicitly empty.
	eval "block=\${CONFIG_${section}_block_wan-1}"
	[ "$block" = 1 ] || fail "device $section opted out of blocking; explicitly enable blocking or remove the device"
	config_get mac "$section" mac
	case "$mac" in *[!a-fA-F0-9:]*) fail "invalid MAC address in device $section" ;; esac
	case "$mac" in
		00:00:00:00:00:00|00:11:22:33:44:55) fail "placeholder MAC address in device $section" ;;
		[[:xdigit:]][02468aAcCeE]:[[:xdigit:]][[:xdigit:]]:[[:xdigit:]][[:xdigit:]]:[[:xdigit:]][[:xdigit:]]:[[:xdigit:]][[:xdigit:]]:[[:xdigit:]][[:xdigit:]]) ;;
		*) fail "device $section needs a complete, individual unicast MAC address" ;;
	esac
	printf '%s\n' "$mac" | tr A-F a-f >> "$work/macs"
}

check_offload
load_committed switch2-block
config_get global_type global TYPE
[ "$global_type" = global ] || fail 'missing or invalid global section'
config_get enabled global enabled
[ "$enabled" = 1 ] || fail 'isolation is not explicitly enabled in committed settings'
config_get helper global spoof_ip
valid_ipv4 "$helper" || fail 'set a valid unicast Switch Helper IPv4 address'
config_get lan global lan_ip
if [ -n "$lan" ]; then
	valid_ipv4 "$lan" && [ "$lan" != "$helper" ] || fail 'LAN IPv4 must be unicast and distinct from the helper'
fi
: > "$work/macs"
for section in $CONFIG_SECTIONS; do
	config_get kind "$section" TYPE
	case "$kind:$section" in
		global:global) ;;
		device:*) collect_device "$section" ;;
		*) fail "unexpected section $section of type $kind; refusing partial enrollment" ;;
	esac
done
[ -s "$work/macs" ] || fail 'enroll at least one real Wi-Fi or dock MAC address'
sort "$work/macs" > "$work/enrolled"
duplicates=$(uniq -d "$work/enrolled")
[ -z "$duplicates" ] || fail "duplicate enrolled MAC: $duplicates"

# The same source filter sees the original tuple (before conntrack/DNAT/
# TPROXY) and the final local tuple. There is no state/established exception.
# ARP is allowed to reach the bridge host, never to cross the bridge.
allowlist() {
	local family=$1 addr
	printf 'chain s2_allow {\n'
	[ "$family" != bridge ] || printf 'ether type arp accept\n'
	for addr in 255.255.255.255 $lan; do
		printf 'ip daddr %s udp sport 68 udp dport 67 accept\n' "$addr"
	done
	printf 'ip daddr %s udp dport 53 accept\n' "$helper"
	printf 'ip daddr %s tcp dport 53 accept\n' "$helper"
	printf 'ip daddr %s tcp dport 80 accept\n' "$helper"
	printf 'drop\n}\n'
}

base_chain() {
	local hook=$1 prio=$2 verdict=$3 family=$4 mac
	printf 'chain s2_%s {\ntype filter hook %s priority %s; policy accept;\n' "$hook" "$hook" "$prio"
	while IFS= read -r mac; do
		printf 'ether saddr %s %s\n' "$mac" "$verdict"
		if [ "$family:$hook" = bridge:forward ]; then
			printf 'ether daddr %s drop\n' "$mac"
		fi
	done < "$work/enrolled"
	printf '}\n'
}

generate_policy() {
	local family
	for family in inet bridge; do
		printf 'table %s %s {\n' "$family" "$table"
		allowlist "$family"
		if [ "$family" = inet ]; then
			printf 'chain s2_delivery {\nct status dnat drop\nsocket transparent 1 drop\njump s2_allow\n}\n'
		fi
		base_chain prerouting -450 'jump s2_allow' "$family"
		base_chain forward -450 drop "$family"
		if [ "$family" = inet ]; then
			# After conventional input NAT and socket assignment, before delivery.
			base_chain input 2147483646 'jump s2_delivery' "$family"
		fi
		printf '}\n'
	done
}
generate_policy > "$work/desired"

# Compare the entire kernel listing, including every table flag, chain/hook,
# policy, ordered rule and MAC. Ignore ONLY layout. An extra rule, missing
# target, dormant table, changed priority or widened exception must fail.
normalize() { awk 'NF { $1=$1; print }' "$1"; }
active_matches() {
	local family flag
	# Priorities were always numeric before nft introduced -y. Older nft
	# also needs -nn to suppress the port-name resolver.
	if nft -y -v >/dev/null 2>&1; then flag=-y; else flag=-nn; fi
	: > "$work/live"
	for family in inet bridge; do
		nft "$flag" list table "$family" "$table" >> "$work/live" || return 1
	done
	normalize "$work/live" > "$work/actual" || return 1
	awk 'NR == FNR { want[FNR]=$0; n=FNR; next }
		{ got=FNR; if ($0 == want[FNR]) next
		  printf "Expected: %s\nObserved: %s\n", want[FNR], $0; mismatch=1; exit }
		END { if (!mismatch && got < n) print "Missing: " want[got+1]
		      exit (mismatch || got != n) }' "$work/desired" "$work/actual"
}

retain_previous() {
	[ ! -f "$snapshot" ] || install_policy "$snapshot" || fail 'could not restore previous live policy; boot snapshot retained'
}

if [ "$action" = check ]; then
	active_matches || fail 'missing or mismatched isolation table, hook, enrolled MAC, or allowlist; do not connect the console'
	cmp -s "$work/desired" "$snapshot" || fail 'missing or mismatched boot snapshot; reapply the policy before reboot'
else
	# Stage and flush the next boot copy on the destination filesystem before
	# touching the kernel. The old snapshot remains until nft accepts the
	# entire transaction. Unchanged reloads do not write router flash.
	if ! cmp -s "$work/desired" "$snapshot"; then
		mkdir -p "$store"
		staged=$(mktemp "$store/.policy.XXXXXX")
		cat "$work/desired" > "$staged"
		sync
	fi
	if [ "$restored" = 0 ] || [ -n "$staged" ]; then
		install_policy "$work/desired" || fail 'atomic nft install rejected; previous live policy and boot snapshot retained'
	fi
	if ! active_matches; then
		retain_previous
		fail 'installed kernel rules did not match the requested policy; boot snapshot not replaced'
	fi
	if [ -n "$staged" ]; then
		if ! mv -f "$staged" "$snapshot"; then
			retain_previous
			fail 'cannot publish boot snapshot; previous snapshot retained'
		fi
		staged=
		sync
	fi
fi
printf 'Active: IPv4/IPv6 routing and bridge forwarding denied; local DHCPv4 and helper %s DNS/HTTP only. Enrolled MACs:\n' "$helper"
cat "$work/enrolled"
