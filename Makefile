include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-switch2-block
SWITCH2_BLOCK_VERSION:=1.0.0
PKG_RELEASE:=3
# Both SDKs use PKG_SRC_VERSION as-is, but only newer luci.mk appends
# PKG_RELEASE to PKG_VERSION. Use the same app version on IPK and APK.
PKG_SRC_VERSION:=$(SWITCH2_BLOCK_VERSION)-r$(PKG_RELEASE)

LUCI_TITLE:=LuCI support for Nintendo Switch 2 Connection Spoof & Update Blocker
LUCI_DEPENDS:=+luci-base +uhttpd +curl +nftables +kmod-nft-bridge +kmod-nft-socket +flock
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/prerm
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ] && [ "$${PKG_UPGRADE:-0}" != 1 ]; then
	/usr/libexec/switch2-block/apply.sh uninstall || exit 1
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt package scanner signature
