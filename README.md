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

<img width="815" height="290" alt="02 Switch2设置" src="https://github.com/user-attachments/assets/3c353fcc-dd3d-4770-b090-576829f5dd84" />

<img width="550" height="360" alt="03 插件自检" src="https://github.com/user-attachments/assets/4294cbf5-9f59-4922-b679-202821a1597c" />

三、注意事项

 1、必须在插件中准确设置Switch2的mac地址，只有mac地址正确，才能有效防止Switch2主机访问外网。否则防火墙规则会失效，造成主机联到外网。Switch2主机的mac地址可以直接在主机设置的“互联网”功能中查看。 如果连接了wifi或者未联网状态，这里默认查看的是主机无线网卡的mac地址，如果连接了底座，这里看到的就是底座以太网卡的mac地址。 一定要注意区分！！

 2、如果路由器启用了 SSR Plus+ / PassWall / OpenClash 等代理插件，请务必将插件中设置的「任天堂联网测试域名」及「Switch 专用伪装辅助 IP」加入不走代理的白名单，防止流量被代理插件劫持。例如，截图中就是 ctest.p01.ctest.srv.nintendo.net 和 192.168.10.254。
 
 3、由于OpenWRT固件版本众多，兼容性不一，插件不能保证能在所有插件上都能正常工作。因此，为保证不会因为插件工作不正常而造成Switch2主机意外升级，请一定在初次使用插件前，断开路由器的互联网连接！在配置好插件后，首先点击“立即测试伪装服务”按钮，进行插件设置是否生效的检查。只有自建结果3项都返回成功的结果，尤其是防火墙规则状态正常，才能恢复路由器的互联网连接。切记切记!!

  4、插件正常生效后，可以连接路由器所在wifi，让Switch2自动获取ip和DNS服务器。Switch2获取的DNS服务器地址即插件中设置的Switch 专用伪装辅助 IP，如果在插件中为Switch2指定了静态地址，则Switch2会固定使用这个ip。如果插件设置时没有为Switch2分配静态ip，则由路由器自动分配。也可以在Switch2的连接设置里手动指定ip、DNS，设置值与插件一致就可以正常工作。


