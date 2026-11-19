#!/bin/sh
# Switch 2 Connection Spoof & Update Blocker core management script
. /lib/functions.sh

CONF="switch2-block"
CGI_DIR="/www_nintendo/cgi-bin"
CGI_FILE="$CGI_DIR/ctest"
FW_USER="/etc/firewall.user"
NFT_D_FILE="/etc/nftables.d/99-switch2-block.nft"
POLICY="/usr/libexec/switch2-block/policy.sh"

log_msg() {
	logger -t "switch2-block" "$1"
}

# 动态探测当前路由器真实 LAN IP（消除任何硬编码 IP）
detect_lan_ip() {
	local ip
	ip=$(uci -q get network.lan.ipaddr | awk '{print $1}' | awk -F'/' '{print $1}')
	if [ -z "$ip" ]; then
		ip=$(ip -4 addr show br-lan 2>/dev/null | awk '/inet / {print $2}' | cut -d'/' -f1 | head -n1)
	fi
	echo "$ip"
}

# 幂等辅助函数：仅当值不同时才写入 UCI
uci_set_if_diff() {
	local cfg="$1" sec="$2" opt="$3" val="$4"
	local cur
	cur=$(uci -q get "${cfg}.${sec}.${opt}")
	[ "$cur" != "$val" ] && uci set "${cfg}.${sec}.${opt}=${val}"
}

# 幂等辅助函数：按换行符逐行精确比对 list，防止含空格选项被拆分导致重复写入
uci_add_list_unique() {
	local cfg="$1" sec="$2" opt="$3" val="$4"
	local existing old_ifs="$IFS"
	existing=$(uci -q -d '
' get "${cfg}.${sec}.${opt}" 2>/dev/null)
	IFS='
'
	for item in $existing; do
		if [ "$item" = "$val" ]; then
			IFS="$old_ifs"
			return 1
		fi
	done
	IFS="$old_ifs"
	uci add_list "${cfg}.${sec}.${opt}=${val}"
	return 0
}

ensure_cgi() {
	mkdir -p "$CGI_DIR"
	if [ ! -f "$CGI_FILE" ] || ! grep -q "X-Organization: Nintendo" "$CGI_FILE"; then
		cat << 'EOF' > "$CGI_FILE"
#!/bin/sh
printf "Status: 200 OK\r\n"
printf "Content-Type: text/plain\r\n"
printf "Content-Length: 2\r\n"
printf "X-Organization: Nintendo\r\n"
printf "\r\n"
printf "ok"
EOF
		chmod +x "$CGI_FILE"
	fi
}

cleanup_network() {
	if uci -q get network.nintendo >/dev/null; then
		uci -q delete network.nintendo
		uci commit network
	fi
	if [ "$(uci -q get network.lan._switch2_zone_managed)" = "1" ]; then
		local i=0
		while uci -q get firewall.@zone[$i] >/dev/null; do
			if [ "$(uci -q get firewall.@zone[$i].name)" = "lan" ]; then
				uci -q del_list firewall.@zone[$i].network='nintendo'
			fi
			i=$((i + 1))
		done
		uci -q delete network.lan._switch2_zone_managed
		uci commit network
		uci commit firewall
	fi
}

cleanup_dhcp() {
	local lan_ip="$1"
	local old_lan_ip
	old_lan_ip="$(uci -q get dhcp.main_dns._sw2_lan_ip)"
	[ -z "$old_lan_ip" ] && old_lan_ip="$lan_ip"

	uci -q delete dhcp.nintendo_dns
	uci -q delete dhcp.switch2

	while uci -q show dhcp | grep -q "dhcp\.@host\[[0-9]*\]\.tag='switch2'"; do
		local idx
		idx=$(uci -q show dhcp | grep "dhcp\.@host\[[0-9]*\]\.tag='switch2'" | head -n1 | sed -E 's/.*@host\[([0-9]+)\].*/\1/')
		[ -n "$idx" ] && uci -q delete dhcp.@host[$idx]
	done

	if [ "$(uci -q get dhcp.main_dns._switch2_managed)" = "1" ]; then
		[ "$(uci -q get dhcp.main_dns._sw2_add_lan)" = "1" ] && [ -n "$old_lan_ip" ] && uci -q del_list dhcp.main_dns.listen_address="$old_lan_ip"
		[ "$(uci -q get dhcp.main_dns._sw2_add_lo_ip)" = "1" ] && uci -q del_list dhcp.main_dns.listen_address='127.0.0.1'
		[ "$(uci -q get dhcp.main_dns._sw2_add_lo_if)" = "1" ] && uci -q del_list dhcp.main_dns.interface='loopback'
		[ "$(uci -q get dhcp.main_dns._sw2_add_bind)" = "1" ] && uci -q delete dhcp.main_dns.bind_interfaces
		uci -q delete dhcp.main_dns._sw2_lan_ip
		uci -q delete dhcp.main_dns._sw2_add_lan
		uci -q delete dhcp.main_dns._sw2_add_lo_ip
		uci -q delete dhcp.main_dns._sw2_add_lo_if
		uci -q delete dhcp.main_dns._sw2_add_bind
		uci -q delete dhcp.main_dns._switch2_managed
	fi

	if [ "$(uci -q get dhcp.lan._switch2_managed)" = "1" ]; then
		uci -q delete dhcp.lan.instance
		uci -q delete dhcp.lan._switch2_managed
	fi

	if [ "$(uci -q get dhcp.lan._switch2_force_managed)" = "1" ]; then
		uci -q delete dhcp.lan.force
		uci -q delete dhcp.lan._switch2_force_managed
	fi
	uci commit dhcp
}
cleanup_uhttpd() {
	uci -q delete uhttpd.nintendo_ctest
	if [ "$(uci -q get uhttpd.main._switch2_managed)" = "1" ]; then
		local orig_list orig_redir
		orig_list=$(uci -q get uhttpd.main._sw2_orig_listen)
		orig_redir=$(uci -q get uhttpd.main._sw2_orig_redir)
		uci -q delete uhttpd.main.listen_http
		if [ -n "$orig_list" ]; then
			for item in $orig_list; do
				uci add_list uhttpd.main.listen_http="$item"
			done
		else
			uci add_list uhttpd.main.listen_http='0.0.0.0:80'
			uci add_list uhttpd.main.listen_http='[::]:80'
		fi
		if [ -n "$orig_redir" ]; then
			uci set uhttpd.main.redirect_https="$orig_redir"
		fi
		uci -q delete uhttpd.main._sw2_orig_listen
		uci -q delete uhttpd.main._sw2_orig_redir
		uci -q delete uhttpd.main._switch2_managed
	fi
	uci commit uhttpd
	rm -rf /www_nintendo
}

# Upgrade only: retire the old includes after the independent guard is live.
retire_legacy_rules() {
	local changed=0
	if [ -f "$NFT_D_FILE" ]; then
		rm -f "$NFT_D_FILE" || return 1
		changed=1
	fi
	if [ -f "$FW_USER" ] && grep -qx '# BEGIN SWITCH2-BLOCK' "$FW_USER"; then
		grep -qx '# END SWITCH2-BLOCK' "$FW_USER" || return 1
		sed -i '/^# BEGIN SWITCH2-BLOCK$/,/^# END SWITCH2-BLOCK$/d' "$FW_USER" || return 1
		changed=1
	fi
	if uci -q get firewall.switch2_fw_user >/dev/null; then
		uci delete firewall.switch2_fw_user && uci commit firewall || return 1
		changed=1
	fi
	[ "$changed" = 0 ] || /etc/init.d/firewall restart
}

apply_network() {
	local spoof_ip="$1"
	if [ "$(uci -q get network.nintendo)" != "interface" ]; then
		uci set network.nintendo='interface'
	fi
	uci_set_if_diff network nintendo proto 'static'
	uci_set_if_diff network nintendo device 'br-lan'
	if [ "$(uci -q get network.nintendo.ipaddr)" != "${spoof_ip}/24" ]; then
		uci -q delete network.nintendo.ipaddr
		uci add_list network.nintendo.ipaddr="${spoof_ip}/24"
	fi
	uci commit network

	local i=0
	while uci -q get firewall.@zone[$i] >/dev/null; do
		if [ "$(uci -q get firewall.@zone[$i].name)" = "lan" ]; then
			if uci_add_list_unique firewall "@zone[$i]" network 'nintendo'; then
				uci set network.lan._switch2_zone_managed='1'
				uci commit network
			fi
		fi
		i=$((i + 1))
	done
	uci commit firewall
}

apply_dhcp() {
	local lan_ip="$1"
	local spoof_ip="$2"
	local domain="$3"

	if ! uci -q get dhcp.main_dns >/dev/null; then
		if uci -q get dhcp.@dnsmasq[0] >/dev/null; then
			uci rename dhcp.@dnsmasq[0]='main_dns'
		else
			uci set dhcp.main_dns='dnsmasq'
		fi
	fi

	local prev_lan_ip
	prev_lan_ip="$(uci -q get dhcp.main_dns._sw2_lan_ip)"
	if [ -n "$prev_lan_ip" ] && [ "$prev_lan_ip" != "$lan_ip" ] && [ "$(uci -q get dhcp.main_dns._sw2_add_lan)" = "1" ]; then
		uci -q del_list dhcp.main_dns.listen_address="$prev_lan_ip"
		uci -q delete dhcp.main_dns._sw2_add_lan
	fi

	uci_set_if_diff dhcp main_dns _switch2_managed '1'
	uci_set_if_diff dhcp main_dns _sw2_lan_ip "$lan_ip"

	if uci_add_list_unique dhcp main_dns listen_address "$lan_ip"; then
		uci set dhcp.main_dns._sw2_add_lan='1'
	fi
	if uci_add_list_unique dhcp main_dns listen_address '127.0.0.1'; then
		uci set dhcp.main_dns._sw2_add_lo_ip='1'
	fi
	if uci_add_list_unique dhcp main_dns interface 'loopback'; then
		uci set dhcp.main_dns._sw2_add_lo_if='1'
	fi
	if [ "$(uci -q get dhcp.main_dns.bind_interfaces)" != "1" ]; then
		uci set dhcp.main_dns.bind_interfaces='1'
		uci set dhcp.main_dns._sw2_add_bind='1'
	fi

	if [ -z "$(uci -q get dhcp.lan.instance)" ]; then
		uci set dhcp.lan.instance='main_dns'
		uci set dhcp.lan._switch2_managed='1'
	fi

	if [ "$(uci -q get dhcp.lan._switch2_force_managed)" = "1" ]; then
		uci -q delete dhcp.lan.force
		uci -q delete dhcp.lan._switch2_force_managed
	fi

	if [ "$(uci -q get dhcp.nintendo_dns)" != "dnsmasq" ]; then
		uci set dhcp.nintendo_dns='dnsmasq'
	fi
	uci -q del_list dhcp.nintendo_dns.notinterface='lan'
	uci_set_if_diff dhcp nintendo_dns confdir '/tmp/dnsmasq-switch2.d'
	if [ "$(uci -q get dhcp.nintendo_dns.listen_address)" != "$spoof_ip" ]; then
		uci -q delete dhcp.nintendo_dns.listen_address
		uci add_list dhcp.nintendo_dns.listen_address="$spoof_ip"
	fi
	uci_set_if_diff dhcp nintendo_dns bind_interfaces '1'
	uci_set_if_diff dhcp nintendo_dns port '53'
	uci_set_if_diff dhcp nintendo_dns noresolv '1'
	uci_set_if_diff dhcp nintendo_dns localuse '0'
	uci_set_if_diff dhcp nintendo_dns rebind_protection '0'

	if [ "$(uci -q get dhcp.nintendo_dns.address)" != "/${domain}/${spoof_ip}" ]; then
		uci -q delete dhcp.nintendo_dns.address
		uci add_list dhcp.nintendo_dns.address="/${domain}/${spoof_ip}"
	fi
	uci_set_if_diff dhcp nintendo_dns server '/#/'
	uci_set_if_diff dhcp nintendo_dns leasefile '/tmp/dhcp.leases.nintendo'

	if [ "$(uci -q get dhcp.switch2)" != "tag" ]; then
		uci set dhcp.switch2='tag'
	fi
	if [ "$(uci -q get dhcp.switch2.dhcp_option)" != "6,${spoof_ip}" ]; then
		uci -q delete dhcp.switch2.dhcp_option
		uci add_list dhcp.switch2.dhcp_option="6,${spoof_ip}"
	fi

	while uci -q show dhcp | grep -q "dhcp\.@host\[[0-9]*\]\.tag='switch2'"; do
		local idx
		idx=$(uci -q show dhcp | grep "dhcp\.@host\[[0-9]*\]\.tag='switch2'" | head -n1 | sed -E 's/.*@host\[([0-9]+)\].*/\1/')
		[ -n "$idx" ] && uci -q delete dhcp.@host[$idx]
	done

	add_host_entry() {
		local cfg="$1"
		local mac ip
		config_get mac "$cfg" mac ""
		config_get ip "$cfg" ip ""
		mac=$(echo "$mac" | tr 'a-f' 'A-F' | tr -d ' ')
		[ -z "$mac" ] && return
		local existing_idx
		existing_idx=$(uci -q show dhcp | grep -i "dhcp\.@host\[[0-9]*\]\.mac=.*${mac}" | head -n1 | sed -E 's/.*@host\[([0-9]+)\].*/\1/')
		[ -n "$existing_idx" ] && uci -q delete dhcp.@host[$existing_idx]
		local hsec
		hsec=$(uci add dhcp host)
		# OpenWrt skips dynamic hosts without a hostname. A LuCI display
		# label may contain spaces; never pass it to dnsmasq as a hostname.
		uci set dhcp.$hsec.name="switch2-$(printf '%s' "$mac" | tr -d ':')"
		uci set dhcp.$hsec.instance='main_dns'
		uci set dhcp.$hsec.mac="$mac"
		[ -n "$ip" ] && uci set dhcp.$hsec.ip="$ip"
		uci set dhcp.$hsec.tag='switch2'
	}
	config_foreach add_host_entry device
	uci commit dhcp
}
apply_uhttpd() {
	local lan_ip="$1"
	local spoof_ip="$2"
	ensure_cgi

	if [ "$(uci -q get uhttpd.main._switch2_managed)" != "1" ]; then
		local cur_listen cur_redir
		cur_listen=$(uci -q get uhttpd.main.listen_http)
		if [ -n "$cur_listen" ]; then
			uci -q delete uhttpd.main._sw2_orig_listen
			for item in $cur_listen; do
				uci add_list uhttpd.main._sw2_orig_listen="$item"
			done
		fi
		cur_redir=$(uci -q get uhttpd.main.redirect_https)
		[ -n "$cur_redir" ] && uci set uhttpd.main._sw2_orig_redir="$cur_redir"
		uci set uhttpd.main._switch2_managed='1'
	fi

	uci -q delete uhttpd.main.listen_http
	uci_add_list_unique uhttpd main listen_http "${lan_ip}:80"
	uci_add_list_unique uhttpd main listen_http "127.0.0.1:80"
	uci_set_if_diff uhttpd main redirect_https '0'

	if [ "$(uci -q get uhttpd.nintendo_ctest)" != "uhttpd" ]; then
		uci set uhttpd.nintendo_ctest='uhttpd'
	fi
	if [ "$(uci -q get uhttpd.nintendo_ctest.listen_http)" != "${spoof_ip}:80" ]; then
		uci -q delete uhttpd.nintendo_ctest.listen_http
		uci add_list uhttpd.nintendo_ctest.listen_http="${spoof_ip}:80"
	fi
	uci_set_if_diff uhttpd nintendo_ctest home '/www_nintendo'
	uci_set_if_diff uhttpd nintendo_ctest cgi_prefix '/cgi-bin'
	uci_add_list_unique uhttpd nintendo_ctest index_page 'cgi-bin/ctest'
	uci_set_if_diff uhttpd nintendo_ctest error_page '/cgi-bin/ctest'
	uci_set_if_diff uhttpd nintendo_ctest rfc1918_filter '0'
	uci_set_if_diff uhttpd nintendo_ctest no_dirlists '1'
	uci_set_if_diff uhttpd nintendo_ctest max_requests '3'
	uci_set_if_diff uhttpd nintendo_ctest max_connections '20'
	uci_set_if_diff uhttpd nintendo_ctest script_timeout '10'
	uci_set_if_diff uhttpd nintendo_ctest network_timeout '10'
	uci commit uhttpd
}

start_service() {
	local enabled lan_ip spoof_ip test_domain
	enabled=$(uci -q get "/etc/config/$CONF.global.enabled") || return 1
	case "$enabled" in
		0) disable_service; return $? ;;
		1) ;;
		*) log_msg "Invalid enable flag; retaining isolation"; return 1 ;;
	esac
	config_load "/etc/config/$CONF" || return 1
	config_get lan_ip global lan_ip ""
	config_get spoof_ip global spoof_ip ""
	config_get test_domain global test_domain "ctest.p01.ctest.srv.nintendo.net"

	if [ -z "$lan_ip" ] || [ -z "$spoof_ip" ] || [ "$lan_ip" = "$spoof_ip" ]; then
		log_msg "Error: Invalid or undetected LAN/Spoof IP (LAN: '$lan_ip', Spoof: '$spoof_ip'), aborting."
		return 1
	fi

	# Install and verify isolation before changing *any* network listeners.
	"$POLICY" apply || { log_msg "Isolation apply failed; do not connect the console"; return 1; }
	/etc/init.d/switch2-guard enabled || /etc/init.d/switch2-guard enable || return 1
	retire_legacy_rules || return 1
	apply_network "$spoof_ip" && apply_dhcp "$lan_ip" "$spoof_ip" "$test_domain" &&
		apply_uhttpd "$lan_ip" "$spoof_ip" && ifup nintendo &&
		/etc/init.d/dnsmasq restart && /etc/init.d/uhttpd restart || {
		log_msg "Helper setup failed; isolation remains installed"
		return 1
	}
}

disable_service() {
	config_load "/etc/config/$CONF" || return 1
	local lan_ip
	config_get lan_ip global lan_ip ""
	[ -z "$lan_ip" ] && lan_ip=$(detect_lan_ip)

	retire_legacy_rules || return 1
	if uci -q get network.nintendo >/dev/null || uci -q get dhcp.nintendo_dns >/dev/null ||
			uci -q get uhttpd.nintendo_ctest >/dev/null; then
		log_msg "Removing Switch helpers after explicit disable"
		cleanup_uhttpd
		cleanup_dhcp "$lan_ip"
		ifdown nintendo >/dev/null 2>&1
		cleanup_network
		/etc/init.d/dnsmasq restart && /etc/init.d/uhttpd restart || return 1
	fi
	[ "$1" = uninstall ] || [ "$(uci -q get "/etc/config/$CONF.global.enabled")" = 0 ] || return 1
	"$POLICY" remove
}

# Serialize helper setup/teardown too, not just each kernel transaction.
exec 9>/var/lock/switch2-helpers.lock || exit 1
flock -x 9 || exit 1
case "$1" in
	start)
		start_service
		;;
	uninstall)
		disable_service uninstall
		;;
	*)
		echo "Usage: $0 {start|uninstall}" >&2
		exit 1
		;;
esac
