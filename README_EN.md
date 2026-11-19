# luci-app-switch2-block

**English** | [简体中文](./README.md)

Allows Switch 2 / Switch 1 to pass the local network connection test while completely blocking external internet updates via a standalone `dnsmasq` instance and spoofed `uHTTPd` responses. At the same time, it automatically generates firewall rules to prevent the Switch 2 from accessing the internet, eliminating the risk of accidental system updates or triggering a "supernag".

## I. Features:
1. This is an OpenWRT soft-router plugin that uses a standalone `dnsmasq` instance and spoofed `uHTTPd` responses to let the Switch 2 pass the LAN connection test while completely isolated from external updates.  
  💡 **Enabling this plugin will not affect normal internet access or proxy traffic for other devices on your network.**

2. Compatible with OpenWRT firmware versions 19.XX through 25.XX. Compiled in `.ipk` format by default. If you need the `.apk` format, please compile it yourself. *(Apologies for not providing `.apk` builds, as my own LEDE firmware uses `.ipk` packages.)*

3. Compatible with both `fw3` and `fw4` firewalls. It automatically detects your current firewall version and generates rules to block the Switch 2 from accessing the external internet.

4. Includes built-in self-check features to verify the blocking rules and spoofing results directly within the plugin interface.

## II. Screenshots

<img width="2174" height="1786" alt="01 Main Interface" src="https://github.com/user-attachments/assets/133947c3-a269-45c5-849b-2054f2ede62a" />

<img width="815" height="290" alt="02 Switch2 Settings" src="https://github.com/user-attachments/assets/c483d9ef-bb61-4f4b-a510-7ac9f33f5409" />

<img width="550" height="360" alt="03 Plugin Self-Check" src="https://github.com/user-attachments/assets/d2eb1876-ea19-4803-8701-a3a904b70899" />

## III. Important Notes

1. **Modified Configuration Files**: The plugin modifies three configuration files under `/etc/config/`: `dhcp`, `network`, and `uhttpd` **(please back up these three files before using the plugin)**. It will also generate a plugin configuration file named `switch2-block` in the same directory.

2. **Firewall Rule Locations**:
   - **(1) `fw4` Firewall (Native Directory)**: Set **fw4 Firewall Rule Mode** to **Native directory: /etc/nftables.d/ (OpenWrt)** on standard OpenWrt. The firewall loads `/etc/nftables.d/99-switch2-block.nft` at startup.
   - **(2) `fw4` Firewall (Custom File)**: Select **Custom rules file: /etc/firewall.user (LEDE)** on Lean's LEDE or another build that supports custom rules in `/etc/firewall.user`. The app appends rules to that file.
   - **(3) `fw3` Firewall**: Firewall rules are written directly to `/etc/firewall.user`.

3. **MAC Address Accuracy**: You must enter the exact MAC address of your Switch 2 in the plugin. The firewall rules will only block internet access if the MAC address is accurate; otherwise, the rules will fail and the console will connect to the internet. You can find the MAC address under **System Settings -> Internet** on your console. When connected via Wi-Fi or offline, this displays the **wireless MAC address**; when docked with a wired connection, it displays the **dock's Ethernet MAC address**. **Be sure to distinguish between the two!**

4. **Proxy Bypass**: If you use SSR Plus+, PassWall, or OpenClash, add the **Nintendo Connection Test Domain** and **Switch Helper IP** to its bypass list. For example, add `ctest.p01.ctest.srv.nintendo.net` and `192.168.10.254`.

5. **Disconnect the Internet Before Setup**: Disconnect the router from the internet before first use to prevent accidental updates. After setup, click **Run Self-Test**. Reconnect only after all four checks pass, including the firewall rules.

   Self-test results:
   - **DNS redirect**: The result must match the Switch Helper IP. If it does not, check the proxy bypass list.
   - **HTTP response**: The result must be `200 OK` with the 2-byte body `ok`.
   - **Port 80**: On the Switch Helper IP, `uHTTPd` must be the only service listening on port 80.
   - **Firewall rules**: Do not connect the Switch if the firewall rules are missing or inactive.

6. **Connect the Switch**: Once the checks pass, connect to Wi-Fi and set IP and DNS to Automatic. The Switch gets the **Switch Helper IP** as its DNS server. If you leave **Static IP (Optional)** blank, DHCP assigns an IP. You can also enter the same IP and DNS settings on the Switch manually.

7. **Open the App**: In LuCI, go to **Services → Switch 2 Blocker** or open `http://<router-ip>/cgi-bin/luci/admin/services/switch2-block`. English is the default. Simplified Chinese uses the LuCI translation package.
   If the menu item does not appear immediately, SSH into your router and run the following commands to clear the LuCI cache and refresh the menu (or simply reboot the router):

   ```bash
   rm -rf /tmp/luci-indexcache /tmp/luci-modulecache/
   /etc/init.d/rpcd restart
   /etc/init.d/uhttpd restart
   ```

8. **Checking System Logs**: You can verify whether the plugin is running properly by checking the startup entries in the System Log. Normal startup logs should look similar to the following:

   ```text
   [2026年11月17日 GMT+8 23:43:38] user.notice: switch2-block: Applying Switch 2 spoof & block (LAN: 192.168.10.1, Spoof: 192.168.10.254, ForceDHCP: 0, FWMode: firewall_user)
   [2026年11月17日 GMT+8 23:43:38] user.notice: switch2-block: Using fw4 + /etc/firewall.user mode
   [2026年11月17日 GMT+8 23:43:38] daemon.notice: netifd: Interface 'nintendo' is setting up now
   [2026年11月17日 GMT+8 23:43:38] daemon.notice: netifd: Interface 'nintendo' is now up
   ```
