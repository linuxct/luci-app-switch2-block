# luci-app-switch2-block

**English** | [简体中文](./README.md)

This LuCI app lets a Switch 2 or Switch 1 pass Nintendo's connection test **locally**, while denying internet access through this router for its enrolled network adapters. Passing the Nintendo test is not evidence of internet isolation.

## Installing a signed APK (OpenWrt 25.12+)

Download the new `.apk` and obtain [the project's public key](./luci-app-switch2-block-apk.pem) from this repository. Verify its file checksum before trusting it:

```sh
echo 'cc1834e4ae149c861f6ae203d70304a864ba1cf2b1bbecb338d18fcc8f473296  luci-app-switch2-block-apk.pem' | sha256sum -c -
```

Copy the public key and APK to the router. As root, move the key to `/etc/apk/keys/` and install the APK with LuCI or `apk add /tmp/<package>.apk`. Trusting this key authorizes packages signed by this project. Older unsigned builds will still be rejected; use a freshly built signed APK.

## Before enabling

**Do not install an upstream APK/IPK over this fork, even if its version is higher. The package name is shared; upstream does not enforce this fork’s boot guard or its complete isolation checks. Keep the console disconnected during package changes.**

**IPK upgrades are not published by this workflow.** In an upgrade test, the previous fork IPK's removal script deleted the live guard before the new package could run, and opkg replaced the enrollment configuration. Do not perform an in-place upgrade from a previously distributed IPK or assume a successful opkg install means isolation is active.

1. Keep the console offline throughout installation, upgrades, and enrollment. Back up `/etc/config/{network,dhcp,uhttpd,firewall,switch2-block}`. On upgrade from the old firewall-include implementation, the **old package's** removal script may stop its rules.
2. Use a LAN where **this OpenWrt device is the only path out**. Put the console on a dedicated wired segment or isolated SSID with no peer, upstream AP, second gateway, or hardware-switched path to another internet-capable device. The helper uses the `lan` network on `br-lan` and an unused IPv4 address in its `/24`. A secondary DNS server on a shared LAN cannot provide this guarantee.
3. Disable software/hardware flow offloading and vendor acceleration. Reboot offline after changing acceleration settings. Do not use firmware that bypasses Linux packet filtering, starts networking before the guard, or flushes third-party nftables tables. Exclude the console and its local helper services from proxy interception; DHCP, DNS and HTTP on the permitted endpoints must not relay traffic upstream.
4. In **Network → Switch 2 Blocker**, add the actual MAC of **each** adapter: Wi-Fi and every Ethernet dock/adapter the console will use. Enable blocking for every row. Remove stale rows. There is no automatic Nintendo device identification. New adapters, other Wi-Fi networks and mobile hotspots are not protected.
   The helper supports up to eight distinct test hostnames. Leave the default unless you need additional local test responses. Adding a hostname never grants it internet access.
5. Enable the module and click **Save & Apply**. Use automatic IPv4/DNS on the console. For the first test, use a disposable client enrolled on the same port/SSID and a reachable **isolated** WAN-side test server, not the public internet. Verify that the helper DNS and HTTP work, that neither IPv4 nor IPv6 reaches the server, and that another, unenrolled client *can* reach it. Repeat across firewall reload and router reboot before connecting a real WAN.

## What is enforced

The package requires nftables with `inet`, `bridge` and socket matching support, even on a router whose main firewall uses fw3. It does not choose a firewall from an installed executable or write its rules into `/etc/firewall.user`. Firmware missing the required kernel modules is not supported.

The guard permits only the local IPv4 DHCP exchange, DNS (TCP/UDP 53) and HTTP (TCP 80) at the helper address, plus ARP for local address resolution. It drops routed IPv4/IPv6 and software-bridged forwarding from enrolled MACs. The DNS helper has no upstream resolver. Other clients are not matched by the guard.

Rules are replaced as a single nftables transaction, independently of the main firewall. Stopping or restarting helper services or shutting down does not disable isolation. Explicitly disabling the module or uninstalling it removes protection: disconnect the console first.

## Verification and recovery

**Run Self-Test** checks the router's helper services and policy. A green result does not measure packets leaving the console, identify an unregistered dock, or certify your switch hardware. To check the running policy from SSH:

```sh
/usr/libexec/switch2-block/policy.sh check
```

If activation fails, **do not bring a newly enrolled adapter online**. A rejected configuration is not active; an existing guard is not removed to make way for it. Check `logread -e switch2-block` and correct the error.

**Boot failure affects the entire router:** when protection is enabled, the early guard holds normal network startup until it can restore and apply the required policy. This can make LuCI and SSH unavailable. With the console disconnected, use a local console or OpenWrt failsafe (`mount_root` if needed) to repair the configuration. To explicitly abandon isolation:

```sh
uci set switch2-block.global.enabled='0'
uci commit switch2-block
reboot
```
