# luci-app-switch2-block
通过独立 dnsmasq 实例与 uHTTPd 伪装响应，使 Switch 2 / Switch 1 在完全断绝外网更新的情况下通过局域网连接测试。同时通过自动生成的防火墙规则，禁止Switch2连接外网，避免主机意外升级或被supernag的风险。

一、插件特性：
1、本插件为OpenWRT软路由插件，通过独立 dnsmasq 实例与 uHTTPd 伪装响应，使 Switch 2  在完全断绝外网更新的情况下通过局域网连接测试。
      而且启用本插件并不会影响网络中其他终端正常上网以及流量代理。

2、插件兼容19.XX-25.XX各版本OpenWRT固件，默认编译为ipk格式，如果需要apk格式，请自行编译。（因为我自己用的LEDE固件使用的插件是ipk格式，所以未编译apk格式，请见谅。）

3、插件兼容fw3和fw4防火墙，且可以自动匹配当前防火墙版本，提供拦截Switch2拦截外网的防火墙规则。

4、插件自带拦截规则和伪装结果检测功能，可以直接在插件中查看伪装检测结果。

二、插件截图

<img width="2174" height="1786" alt="01 主界面" src="https://github.com/user-attachments/assets/ea36db0d-8e63-4689-b579-b5c10d78ad58" />

<img width="1632" height="580" alt="02 Switch2设置" src="https://github.com/user-attachments/assets/3c353fcc-dd3d-4770-b090-576829f5dd84" />

<img width="1092" height="718" alt="03 插件自检" src="https://github.com/user-attachments/assets/4294cbf5-9f59-4922-b679-202821a1597c" />



