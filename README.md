# luci-app-switch2-block
通过独立 dnsmasq 实例与 uHTTPd 伪装响应，使 Switch 2 / Switch 1 在完全断绝外网更新的情况下通过局域网连接测试。同时通过自动生成的防火墙规则，禁止Switch2连接外网，避免主机意外升级或被supernag的风险。
