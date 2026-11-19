#!/bin/sh
# Linux with user namespaces, nftables kernel support, and an unpacked native-arch
# OpenWrt rootfs containing the package dependencies. No WAN, host rules or flash.
set -eu
if [ "$#" -ne 1 ]; then echo "usage: $0 /path/to/openwrt-rootfs" >&2; exit 2; fi
root=$(realpath "$1")
[ -x "$root/sbin/uci" ] && [ -f "$root/lib/functions.sh" ] || { echo 'Expected an OpenWrt rootfs' >&2; exit 2; }
policy=$(realpath "$(dirname "$0")/../root/usr/libexec/switch2-block/policy.sh")
domains=$(realpath "$(dirname "$policy")/domains.sh")
work=$(mktemp -d); trap 'rmdir "$work"' EXIT
unshare --user --map-root-user --mount --net --pid --fork sh -eu -c '
 mount --make-rprivate /
 mount -t tmpfs tmpfs "$2"; mkdir "$2/root" "$2/upper" "$2/work"
 mount -t overlay -o "lowerdir=$1,upperdir=$2/upper,workdir=$2/work" overlay "$2/root"
 cd "$2/root"; mount -t proc proc proc; mount -t tmpfs tmpfs tmp
 mkdir -p tmp/lock; touch dev/null; mount --bind /dev/null dev/null
 cp "$3" tmp/policy.sh
 cp "$4" tmp/domains.sh
 exec chroot . /bin/sh -eu
' sh "$root" "$work" "$policy" "$domains" <<'TEST'
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /var/lock /etc/config
printf "config defaults\n\toption flow_offloading 0\n" >/etc/config/firewall
cat >/etc/config/switch2-block <<'CONFIG'
config global 'global'
 option enabled '1'
 option lan_ip '192.168.1.1'
 option spoof_ip '192.168.1.254'
config device 'wifi'
 option mac '02:00:00:00:00:10'
config device 'dock'
 option mac '02:00:00:00:00:20'
CONFIG
policy() { sh /tmp/policy.sh "$@"; }
reject() { if "$@"; then echo "Unexpected success: $*" >&2; exit 1; fi; }
policy apply; policy check
nft list ruleset >/tmp/original
# Domains affect only the helper and must not change policy across a reload.
test_domains() (
	set +u  # OpenWrt's config helpers assume unset UCI internals are empty.
	. /lib/functions.sh
	. /tmp/domains.sh
	config_load /etc/config/switch2-block || exit 1
	switch2_test_domains
)
[ "$(test_domains)" = ctest.p01.ctest.srv.nintendo.net ]
uci set switch2-block.global.test_domain=Legacy.Example
uci commit switch2-block
[ "$(test_domains)" = Legacy.Example ]
uci delete switch2-block.global.test_domain
uci add_list switch2-block.global.test_domain=first.example
uci add_list switch2-block.global.test_domain=second.example
uci commit switch2-block
[ "$(test_domains)" = "$(printf 'first.example\nsecond.example')" ]
policy apply; policy check
nft list ruleset >/tmp/after; cmp /tmp/original /tmp/after
uci add_list switch2-block.global.test_domain=First.Example
uci commit switch2-block
reject test_domains
uci del_list switch2-block.global.test_domain=First.Example
uci add_list 'switch2-block.global.test_domain=/example/198.18.0.10'
uci commit switch2-block
reject test_domains
uci del_list 'switch2-block.global.test_domain=/example/198.18.0.10'
uci commit switch2-block
uci set switch2-block.dock.mac=11:22:33:44:55:66; uci commit switch2-block
reject policy apply
nft list ruleset >/tmp/after; cmp /tmp/original /tmp/after
uci set switch2-block.dock.mac=02:00:00:00:00:20; uci commit switch2-block
# The old checker would pass with the entire forwarding chain empty.
nft flush chain inet switch2_block s2_forward
reject policy check
policy restore; policy check
# Cold start with a bad new config must restore the previous guard and fail,
# not tell init it is safe to start the network.
nft flush ruleset
uci set firewall.@defaults[0].flow_offloading=1; uci commit firewall
reject policy restore
nft list ruleset >/tmp/after; cmp /tmp/original /tmp/after
echo 'PASS: domain validation, unchanged policy, failed reconfiguration, partial policy, and cold restore'
TEST
