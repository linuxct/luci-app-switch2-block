'use strict';
'require view';
'require form';
'require uci';
'require fs';
'require ui';

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('switch2-block'),
			uci.load('network').catch(function() { return null; }),
			fs.stat('/usr/sbin/nft').then(function() { return true; }).catch(function() {
				return fs.stat('/sbin/fw4').then(function() { return true; }).catch(function() { return false; });
			})
		]);
	},

	detectNetworkDefaults: function() {
		var rawIp = uci.get('network', 'lan', 'ipaddr') || '';
		if (Array.isArray(rawIp)) {
			rawIp = rawIp[0] || '';
		}
		var detectedLanIp = String(rawIp).trim().split(/\s+/)[0].split('/')[0];
		var detectedSpoofIp = '';
		var prefix = '';

		if (detectedLanIp && detectedLanIp.split('.').length === 4) {
			var parts = detectedLanIp.split('.');
			prefix = parts.slice(0, 3).join('.');
			detectedSpoofIp = (parts[3] === '254') ? (prefix + '.253') : (prefix + '.254');
		}

		return {
			lanIp: detectedLanIp,
			spoofIp: detectedSpoofIp,
			prefix: prefix
		};
	},

	handleTestSpoof: function(m, enableOpt, forceDhcpOpt, lanOpt, spoofOpt, domainOpt, fwModeOpt, isFw4, netDefaults) {
		var savedEnabled = uci.get('switch2-block', 'global', 'enabled') || '0';
		var savedForceDhcp = uci.get('switch2-block', 'global', 'force_dhcp') || '0';
		var savedLanIp = uci.get('switch2-block', 'global', 'lan_ip') || netDefaults.lanIp || '';
		var savedSpoofIp = uci.get('switch2-block', 'global', 'spoof_ip') || netDefaults.spoofIp || '';
		var savedDomain = uci.get('switch2-block', 'global', 'test_domain') || 'ctest.p01.ctest.srv.nintendo.net';
		var savedFwMode = uci.get('switch2-block', 'global', 'fw_mode') || 'firewall_user';

		var curEnabled = enableOpt ? enableOpt.formvalue('global') : savedEnabled;
		var curForceDhcp = forceDhcpOpt ? forceDhcpOpt.formvalue('global') : savedForceDhcp;
		var curLanIp = lanOpt ? (lanOpt.formvalue('global') || savedLanIp) : savedLanIp;
		var curSpoofIp = spoofOpt ? (spoofOpt.formvalue('global') || savedSpoofIp) : savedSpoofIp;
		var curDomain = domainOpt ? (domainOpt.formvalue('global') || savedDomain) : savedDomain;
		var curFwMode = fwModeOpt ? (fwModeOpt.formvalue('global') || savedFwMode) : savedFwMode;

		if (curEnabled !== '1') {
			ui.addNotification(null, E('p', _('当前未启用「启用伪装与断网保护」，请先勾选并点击「保存并应用」后再执行自检。')), 'warning');
			return;
		}

		var pendingChanges = uci.changes();
		var hasPendingUci = pendingChanges && pendingChanges['switch2-block'] && pendingChanges['switch2-block'].length > 0;

		if (hasPendingUci ||
			curEnabled !== savedEnabled ||
			curForceDhcp !== savedForceDhcp ||
			curLanIp !== savedLanIp ||
			curSpoofIp !== savedSpoofIp ||
			curDomain !== savedDomain ||
			curFwMode !== savedFwMode) {
			ui.addNotification(null, E('p', _('检测到当前页面参数或受控设备列表已修改但尚未生效，请先点击底部的「保存并应用」后再进行自检！')), 'warning');
			return;
		}

		if (!curSpoofIp) {
			ui.addNotification(null, E('p', _('伪装辅助 IP 为空，请先填写并点击「保存并应用」。')), 'error');
			return;
		}

		var devices = uci.sections('switch2-block', 'device') || [];
		var hasBlockDevice = devices.some(function(dev) {
			return dev.mac && (dev.block_wan === '1' || dev.block_wan === undefined);
		});

		ui.showModal(_('正在执行连通性伪装自检...'), [
			E('p', { 'class': 'spinning' }, _('正在调用 test.sh 验证 DNS 劫持、uHTTPd 2 字节响应、80 端口占用及防火墙规则...'))
		]);

		var targetFwFile = (isFw4 && curFwMode === 'nftables_d')
			? '/etc/nftables.d/99-switch2-block.nft'
			: '/etc/firewall.user';

		var checkFwRule = fs.read(targetFwFile).then(function(content) {
			return (content || '').indexOf('Block_Switch2_') !== -1;
		}).catch(function() {
			return false;
		});

		return Promise.all([
			fs.exec('/usr/libexec/switch2-block/test.sh', [curSpoofIp, curDomain]),
			checkFwRule
		]).then(function(results) {
			var res = results[0];
			var fwRuleInFile = results[1];
			var rawOut = (res.stdout || '') + (res.stderr || '');
			var dnsOut = '', httpHeader = '', bodyLen = '0', body = '', portOwner = '', fwActiveRules = '';

			var mDns = rawOut.match(/=== DNS_RESULT ===\n([\s\S]*?)\n=== HTTP_HEADER ===/);
			var mHdr = rawOut.match(/=== HTTP_HEADER ===\n([\s\S]*?)\n=== HTTP_BODY_LEN ===/);
			var mLen = rawOut.match(/=== HTTP_BODY_LEN ===\n([\s\S]*?)\n=== HTTP_BODY ===/);
			var mBody = rawOut.match(/=== HTTP_BODY ===\n([\s\S]*?)\n=== HTTP_PORT_OWNER ===/);
			var mPort = rawOut.match(/=== HTTP_PORT_OWNER ===\n([\s\S]*?)\n=== FW_ACTIVE_RULES ===/);
			var mFw = rawOut.match(/=== FW_ACTIVE_RULES ===\n([\s\S]*)$/);

			if (mDns && mDns[1]) dnsOut = mDns[1].trim();
			if (mHdr && mHdr[1]) httpHeader = mHdr[1].trim();
			if (mLen && mLen[1]) bodyLen = mLen[1].trim();
			if (mBody && mBody[1]) body = mBody[1];
			if (mPort && mPort[1]) portOwner = mPort[1].trim();
			if (mFw && mFw[1]) fwActiveRules = mFw[1].trim();

			var fwRuleLines = fwActiveRules ? fwActiveRules.split('\n').filter(function(line) { return line.trim() !== ''; }) : [];
			var fwActiveCount = fwRuleLines.length;

			// 1. 剥离前两行的 Server/Address 头部，仅检测 Name: 之后的实际解析应答部分
			var answerPart = dnsOut.split(/Name:/i).slice(1).join('Name:');
			var dnsOk = answerPart.indexOf(curSpoofIp) !== -1;

			// 2. HTTP 响应校验
			var httpOk = httpHeader.indexOf('200 OK') !== -1 && body === 'ok' && bodyLen === '2';

			// 3. 独立解析 80 端口监听归属状态
			var portStatusColor, portStatusText;
			if (!portOwner) {
				portStatusColor = '#d9534f';
				portStatusText = _('异常：未检测到 ' + curSpoofIp + ':80 的监听进程 (uHTTPd 辅助实例未启动)');
			} else if (portOwner.indexOf('uhttpd') !== -1 && portOwner.indexOf('nginx') === -1) {
				portStatusColor = 'green';
				portStatusText = _('正常 (已由 uHTTPd 独占监听 ' + curSpoofIp + ':80，无端口冲突)');
			} else {
				var procMatch = portOwner.match(/\(\("([^"]+)"/);
				var procName = procMatch ? procMatch[1] : _('其他 Web 服务');
				portStatusColor = '#d9534f';
				portStatusText = _('冲突：80 端口被「' + procName + '」全局占用！请将其改为仅监听主 LAN IP (' + curLanIp + ':80)');
			}

			// 4. 防火墙阻断规则状态
			var fwStatusColor, fwStatusText;
			if (!hasBlockDevice) {
				fwStatusColor = 'green';
				fwStatusText = _('已跳过 (受控列表未启用断外网设备)');
			} else if (fwRuleInFile && fwActiveCount > 0) {
				fwStatusColor = 'green';
				fwStatusText = _('已写入 ' + targetFwFile + ' 且内核防火墙已实时生效 (共 ' + fwActiveCount + ' 条规则)');
			} else if (fwRuleInFile && fwActiveCount === 0) {
				fwStatusColor = '#d9534f';
				fwStatusText = _('规则已写入 ' + targetFwFile + '，但内核防火墙未加载！建议切换规则写入方式后重新保存');
			} else {
				fwStatusColor = '#f0ad4e';
				fwStatusText = _('未在 ' + targetFwFile + ' 检测到阻断规则 (请确认已点击「保存并应用」)');
			}

			var preBaseStyle = 'background:#f5f5f5; padding:8px 10px; border:1px solid #e3e3e3; border-radius:4px; font-family:monospace; font-size:12px; line-height:1.45; white-space:pre; overflow-x:auto; overflow-y:auto; margin-bottom:10px;';

			var modalNode = ui.showModal(_('自检结果'), [
				E('div', { 'style': 'margin-bottom: 6px;' }, [
					E('strong', {}, _('1. DNS 劫持状态：')),
					E('span', { 'style': 'color:' + (dnsOk ? 'green' : 'red') + '; font-weight:bold;' },
						dnsOk ? _('正常 (已解析至 ' + curSpoofIp + ')') : _('异常 (未命中目标 IP，请检查全局 DNS 重定向或代理劫持)'))
				]),
				E('pre', { 'style': preBaseStyle + 'max-height:110px;' }, dnsOut || _('无输出')),

				E('div', { 'style': 'margin-bottom: 6px;' }, [
					E('strong', {}, _('2. HTTP 伪装状态：')),
					E('span', { 'style': 'color:' + (httpOk ? 'green' : 'red') + '; font-weight:bold;' },
						httpOk ? _('正常 (返回 200 OK 且正文精确为 2 字节 "ok")') : _('异常 (响应状态或正文字节不符，当前字节数: ' + bodyLen + ')'))
				]),
				E('pre', { 'style': preBaseStyle + 'max-height:165px;' },
					(httpHeader ? httpHeader + '\n\n[Body: "' + body + '" | Bytes: ' + bodyLen + ']' : rawOut || _('无输出'))),

				E('div', { 'style': 'margin-bottom: 6px;' }, [
					E('strong', {}, _('3. 80 端口占用检查：')),
					E('span', { 'style': 'color:' + portStatusColor + '; font-weight:bold;' }, portStatusText)
				]),
				E('pre', { 'style': preBaseStyle + 'max-height:80px;' },
					portOwner || _('未检测到相关 80 端口监听记录')),

				E('div', { 'style': 'margin-bottom: 6px;' }, [
					E('strong', {}, _('4. 防火墙阻断规则状态：')),
					E('span', { 'style': 'color:' + fwStatusColor + '; font-weight:bold;' }, fwStatusText)
				]),
				E('pre', { 'style': preBaseStyle + 'max-height:180px;' },
					fwActiveRules || _('内核防火墙中暂无生效的 Switch 2 阻断规则')),

				E('div', { 'class': 'right', 'style': 'margin-top: 12px;' }, [
					E('button', {
						'class': 'btn cbi-button-neutral',
						'click': ui.hideModal
					}, _('关闭'))
				])
			]);

			// 动态拓宽 LuCI 模态弹窗容器，防止长文本折行
			if (modalNode) {
				modalNode.style.maxWidth = '860px';
				modalNode.style.width = '92vw';
			}
		}).catch(function(err) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('检测执行失败: ') + err.message), 'error');
		});
	},
	render: function(data) {
		var isFw4 = data[2];
		var netDefaults = this.detectNetworkDefaults();
		var m, s, o, enableOpt, forceDhcpOpt, lanOpt, spoofOpt, domainOpt, fwModeOpt;

		m = new form.Map('switch2-block', _('Nintendo Switch 2 联网伪装与系统更新阻断'),
			_('通过独立 dnsmasq 实例与 uHTTPd 伪装响应，使 Switch 2 / Switch 1 在完全断绝外网更新的情况下通过局域网连接测试。') + '<br/>' +
			'<strong style="color:#d9534f;">' + _('提示：') + '</strong>' +
			_('若路由器启用了 SSR Plus+ / PassWall / OpenClash 等代理插件，请务必将「任天堂联网测试域名」及「Switch 专用伪装辅助 IP」加入不走代理的白名单，防止流量被代理插件劫持。'));

		s = m.section(form.NamedSection, 'global', 'global', _('基础网络隔离设置'));
		s.anonymous = true;

		o = s.option(form.DummyValue, '_fw_status', _('当前固件防火墙架构'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			return isFw4
				? '<span style="color:#5cb85c; font-weight:bold;">fw4 (nftables)</span>'
				: '<span style="color:#f0ad4e; font-weight:bold;">fw3 (iptables) - 自动使用 /etc/firewall.user</span>';
		};

		enableOpt = s.option(form.Flag, 'enabled', _('启用伪装与断网保护'),
			_('开启后将自动配置辅助接口、分离 dnsmasq/uHTTPd 监听并注入防火墙阻断规则；关闭后自动无损还原默认网络配置。'));
		enableOpt.rmempty = false;

		forceDhcpOpt = s.option(form.Flag, 'force_dhcp', _('开启强制 DHCP'),
			_('旁路由模式推荐开启。强制由本路由器的 main_dns 接管局域网 DHCP 分配（即设置 dhcp.lan.force=1），防止主路由抢先回应导致 Switch 2 获取到错误的 DNS。'));
		forceDhcpOpt.default = '0';
		forceDhcpOpt.rmempty = false;

		if (isFw4) {
			fwModeOpt = s.option(form.ListValue, 'fw_mode', _('fw4 防火墙规则写入方式'),
				_('官方原版 OpenWrt 22.03+ 推荐选择「原生规则目录」；LEDE 等带自定义规则页面的定制固件推荐选择「自定义规则文件」。'));
			fwModeOpt.value('nftables_d', _('写入 /etc/nftables.d/ 原生规则目录（官方原版通用）'));
			fwModeOpt.value('firewall_user', _('写入 /etc/firewall.user 自定义规则文件（LEDE 固件默认推荐）'));
			fwModeOpt.default = 'firewall_user';
			fwModeOpt.rmempty = false;
		}

		lanOpt = s.option(form.Value, 'lan_ip', _('路由器主 LAN IP'),
			_('主 dnsmasq 与后台管理界面监听的 IP 地址（自动探测当前 LAN 口 IP）。'));
		lanOpt.datatype = 'ip4addr';
		if (netDefaults.lanIp) {
			lanOpt.default = netDefaults.lanIp;
			lanOpt.placeholder = netDefaults.lanIp;
		}
		lanOpt.rmempty = false;

		spoofOpt = s.option(form.Value, 'spoof_ip', _('Switch 专用伪装辅助 IP'),
			_('在 br-lan 上创建的独立虚拟接口 IP，必须与主 LAN IP 在同一网段且不能相同。'));
		spoofOpt.datatype = 'ip4addr';
		if (netDefaults.spoofIp) {
			spoofOpt.default = netDefaults.spoofIp;
			spoofOpt.placeholder = netDefaults.spoofIp;
		}
		spoofOpt.rmempty = false;
		spoofOpt.validate = function(section_id, value) {
			var lanVal = lanOpt.formvalue(section_id);
			if (lanVal && value === lanVal) {
				return _('伪装辅助 IP 不能与路由器主 LAN IP 相同！');
			}
			if (lanVal && value) {
				var p1 = lanVal.split('.').slice(0, 3).join('.');
				var p2 = value.split('.').slice(0, 3).join('.');
				if (p1 !== p2) {
					return _('伪装辅助 IP 必须与主 LAN IP 处于同一 /24 网段（如 ' + p1 + '.254）！');
				}
			}
			return true;
		};

		domainOpt = s.option(form.Value, 'test_domain', _('任天堂联网测试域名'),
			_('默认拦截 ctest.p01.ctest.srv.nintendo.net，通常无需修改。'));
		domainOpt.datatype = 'hostname';
		domainOpt.default = 'ctest.p01.ctest.srv.nintendo.net';
		domainOpt.placeholder = 'ctest.p01.ctest.srv.nintendo.net';
		domainOpt.rmempty = false;

		o = s.option(form.Button, '_test_btn', _('服务连通性自检'),
			_('保存并应用后，点击此按钮调用 test.sh 验证 DNS 解析、HTTP 2 字节响应及防火墙状态。'));
		o.inputtitle = _('立即测试伪装服务');
		o.inputstyle = 'apply';
		o.onclick = L.bind(function() {
			return this.handleTestSpoof(m, enableOpt, forceDhcpOpt, lanOpt, spoofOpt, domainOpt, fwModeOpt, isFw4, netDefaults);
		}, this);

		s = m.section(form.GridSection, 'device', _('受控主机列表 (MAC 精准下发与防火墙兜底)'),
			_('列出的设备在 Wi-Fi 设置为「自动获取 (DHCP)」时，将自动分配专属伪装 DNS，并可选通过防火墙彻底封禁外网访问。'));
		s.addremove = true;
		s.anonymous = true;

		o = s.option(form.Value, 'name', _('设备备注'));
		o.placeholder = 'Switch2';
		o.rmempty = false;

		o = s.option(form.Value, 'mac', _('MAC 地址'));
		o.datatype = 'macaddr';
		o.placeholder = '11:22:33:44:55:66';
		o.rmempty = false;

		o = s.option(form.Value, 'ip', _('分配静态 IP (可选)'),
			_('留空则由路由器自动分配动态 IP，并同样下发专属伪装 DNS。'));
		o.datatype = 'ip4addr';
		o.placeholder = netDefaults.prefix ? _('留空自动分配 (如 ' + netDefaults.prefix + '.x)') : _('留空自动分配');
		o.rmempty = true;
		o.validate = function(section_id, value) {
			if (!value) return true;
			var lanVal = lanOpt.formvalue('global');
			var spoofVal = spoofOpt.formvalue('global');
			if (value === lanVal || value === spoofVal) {
				return _('静态 IP 不能与路由器主 IP 或伪装辅助 IP 相同！');
			}
			if (lanVal) {
				var p1 = lanVal.split('.').slice(0, 3).join('.');
				var p2 = value.split('.').slice(0, 3).join('.');
				if (p1 !== p2) {
					return _('静态 IP 必须与路由器主 LAN IP 处于同一网段（' + p1 + '.x）！');
				}
			}
			return true;
		};

		o = s.option(form.Flag, 'block_wan', _('防火墙彻底断外网'),
			_('注入防火墙规则拦截该 MAC 的 IPv6 ICMPv6 寻址及所有 IPv4/IPv6 外网转发流量，防止后台硬编码 IP 偷跑更新。'));
		o.default = '1';
		o.rmempty = false;

		return m.render();
	}
});
