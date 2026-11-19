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
			ui.addNotification(null, E('p', _('Spoofing and update blocking are off. Enable them, then click Save & Apply.')), 'warning');
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
			ui.addNotification(null, E('p', _('This page or the device list has unsaved changes. Click Save & Apply before running the self-test.')), 'warning');
			return;
		}

		if (!curSpoofIp) {
			ui.addNotification(null, E('p', _('Enter a Switch Helper IP, then click Save & Apply.')), 'error');
			return;
		}

		var devices = uci.sections('switch2-block', 'device') || [];
		var hasBlockDevice = devices.some(function(dev) {
			return dev.mac && (dev.block_wan === '1' || dev.block_wan === undefined);
		});

		ui.showModal(_('Running the Self-Test...'), [
			E('p', { 'class': 'spinning' }, _('Checking the DNS redirect, the 2-byte uHTTPd response, port 80, and the firewall rules.'))
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
				portStatusText = _('Nothing is listening on %s:80. The uHTTPd helper is not running.').format(curSpoofIp);
			} else if (portOwner.indexOf('uhttpd') !== -1 && portOwner.indexOf('nginx') === -1) {
				portStatusColor = 'green';
				portStatusText = _('Only uHTTPd is listening on %s:80.').format(curSpoofIp);
			} else {
				var procMatch = portOwner.match(/\(\("([^"]+)"/);
				var procName = procMatch ? procMatch[1] : _('Other web service');
				portStatusColor = '#d9534f';
				portStatusText = _('"%s" uses port 80 on all addresses. Set it to listen only on the Router LAN IP (%s:80).').format(procName, curLanIp);
			}

			// 4. 防火墙阻断规则状态
			var fwStatusColor, fwStatusText;
			if (!hasBlockDevice) {
				fwStatusColor = 'green';
				fwStatusText = _('Skipped. No device has internet blocking enabled.');
			} else if (fwRuleInFile && fwActiveCount > 0) {
				fwStatusColor = 'green';
				fwStatusText = _('Saved to %s. Active rules in the firewall: %d.').format(targetFwFile, fwActiveCount);
			} else if (fwRuleInFile && fwActiveCount === 0) {
				fwStatusColor = '#d9534f';
				fwStatusText = _('Rules are in %s, but the firewall did not load them. Change the firewall rule mode, then click Save & Apply.').format(targetFwFile);
			} else {
				fwStatusColor = '#f0ad4e';
				fwStatusText = _('No blocking rules in %s. Make sure that you clicked Save & Apply.').format(targetFwFile);
			}

			var preBaseStyle = 'background:#f5f5f5; padding:8px 10px; border:1px solid #e3e3e3; border-radius:4px; font-family:monospace; font-size:12px; line-height:1.45; white-space:pre; overflow-x:auto; overflow-y:auto; margin-bottom:10px;';

			var modalNode = ui.showModal(_('Self-Test Results'), [
				E('div', { 'style': 'margin-bottom: 6px;' }, [
					E('strong', {}, _('1. DNS redirect:') + ' '),
					E('span', { 'style': 'color:' + (dnsOk ? 'green' : 'red') + '; font-weight:bold;' },
						dnsOk ? _('Resolved to %s.').format(curSpoofIp) : _('DNS did not return the Switch Helper IP. Check for a global DNS redirect or a proxy intercepting requests.'))
				]),
				E('pre', { 'style': preBaseStyle + 'max-height:110px;' }, dnsOut || _('No output')),

				E('div', { 'style': 'margin-bottom: 6px;' }, [
					E('strong', {}, _('2. HTTP response:') + ' '),
					E('span', { 'style': 'color:' + (httpOk ? 'green' : 'red') + '; font-weight:bold;' },
						httpOk ? _('Returned 200 OK with the 2-byte body "ok".') : _('Unexpected HTTP status or body length. Bytes: %s.').format(bodyLen))
				]),
				E('pre', { 'style': preBaseStyle + 'max-height:165px;' },
					(httpHeader ? httpHeader + '\n\n' + _('[Body: "%s" | Bytes: %s]').format(body, bodyLen) : rawOut || _('No output'))),

				E('div', { 'style': 'margin-bottom: 6px;' }, [
					E('strong', {}, _('3. Port 80:') + ' '),
					E('span', { 'style': 'color:' + portStatusColor + '; font-weight:bold;' }, portStatusText)
				]),
				E('pre', { 'style': preBaseStyle + 'max-height:80px;' },
					portOwner || _('No listeners on port 80.')),

				E('div', { 'style': 'margin-bottom: 6px;' }, [
					E('strong', {}, _('4. Firewall rules:') + ' '),
					E('span', { 'style': 'color:' + fwStatusColor + '; font-weight:bold;' }, fwStatusText)
				]),
				E('pre', { 'style': preBaseStyle + 'max-height:140px;' },
					fwActiveRules || _('No active Switch 2 blocking rules in the firewall.')),

				E('div', { 'class': 'right', 'style': 'margin-top: 12px;' }, [
					E('button', {
						'class': 'btn cbi-button-neutral',
						'click': ui.hideModal
					}, _('Close'))
				])
			]);

			// 动态拓宽 LuCI 模态弹窗容器，防止长文本折行
			if (modalNode) {
				modalNode.style.maxWidth = '860px';
				modalNode.style.width = '92vw';
			}
		}).catch(function(err) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Could not run the self-test: %s').format(err.message)), 'error');
		});
	},
	render: function(data) {
		var isFw4 = data[2];
		var netDefaults = this.detectNetworkDefaults();
		var m, s, o, enableOpt, forceDhcpOpt, lanOpt, spoofOpt, domainOpt, fwModeOpt;

		m = new form.Map('switch2-block', _('Nintendo Switch 2: Connection Spoofing and Update Blocking'),
			_('Separate dnsmasq and uHTTPd instances mimic the Nintendo test response. Switch 2 and Switch 1 can pass the connection test without internet access.') + '<br/>' +
			'<strong style="color:#d9534f;">' + _('Note:') + '</strong> ' +
			_('If you use a proxy plugin (SSR Plus+, PassWall, or OpenClash), add the Nintendo Connection Test Domain and Switch Helper IP to its bypass list.'));

		s = m.section(form.NamedSection, 'global', 'global', _('Network Isolation'));
		s.anonymous = true;

		o = s.option(form.DummyValue, '_fw_status', _('Current Firewall'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			return isFw4
				? '<span style="color:#5cb85c; font-weight:bold;">fw4 (nftables)</span>'
				: '<span style="color:#f0ad4e; font-weight:bold;">' + _('fw3 (iptables) uses /etc/firewall.user') + '</span>';
		};

		enableOpt = s.option(form.Flag, 'enabled', _('Enable Spoofing and Update Blocking'),
			_('This sets up the helper interface, separates the dnsmasq and uHTTPd listeners, and adds firewall rules. Turning it off restores the original network settings.'));
		enableOpt.rmempty = false;

		forceDhcpOpt = s.option(form.Flag, 'force_dhcp', _('Force DHCP'),
			_('Use this on a secondary router. It sets dhcp.lan.force=1 so main_dns handles LAN DHCP. This keeps the main router from giving the Switch the wrong DNS server.'));
		forceDhcpOpt.default = '0';
		forceDhcpOpt.rmempty = false;

		if (isFw4) {
			fwModeOpt = s.option(form.ListValue, 'fw_mode', _('fw4 Firewall Rule Mode'),
				_('Use the native directory on OpenWrt 22.03 or later. On custom builds such as LEDE, use the custom rules file.'));
			fwModeOpt.value('nftables_d', _('Native directory: /etc/nftables.d/ (OpenWrt)'));
			fwModeOpt.value('firewall_user', _('Custom rules file: /etc/firewall.user (LEDE)'));
			fwModeOpt.default = 'firewall_user';
			fwModeOpt.rmempty = false;
		}

		lanOpt = s.option(form.Value, 'lan_ip', _('Router LAN IP'),
			_('The main dnsmasq and LuCI use this IP. The app detects it from the LAN interface.'));
		lanOpt.datatype = 'ip4addr';
		if (netDefaults.lanIp) {
			lanOpt.default = netDefaults.lanIp;
			lanOpt.placeholder = netDefaults.lanIp;
		}
		lanOpt.rmempty = false;

		spoofOpt = s.option(form.Value, 'spoof_ip', _('Switch Helper IP'),
			_('A separate IP on br-lan. Use a different address in the same subnet as the Router LAN IP.'));
		spoofOpt.datatype = 'ip4addr';
		if (netDefaults.spoofIp) {
			spoofOpt.default = netDefaults.spoofIp;
			spoofOpt.placeholder = netDefaults.spoofIp;
		}
		spoofOpt.rmempty = false;
		spoofOpt.validate = function(section_id, value) {
			var lanVal = lanOpt.formvalue(section_id);
			if (lanVal && value === lanVal) {
				return _('The Switch Helper IP must differ from the Router LAN IP.');
			}
			if (lanVal && value) {
				var p1 = lanVal.split('.').slice(0, 3).join('.');
				var p2 = value.split('.').slice(0, 3).join('.');
				if (p1 !== p2) {
					return _('Use a Switch Helper IP in the same /24 subnet as the Router LAN IP, such as %s.254.').format(p1);
				}
			}
			return true;
		};

		domainOpt = s.option(form.Value, 'test_domain', _('Nintendo Connection Test Domain'),
			_('Default: ctest.p01.ctest.srv.nintendo.net. Usually no change is needed.'));
		domainOpt.datatype = 'hostname';
		domainOpt.default = 'ctest.p01.ctest.srv.nintendo.net';
		domainOpt.placeholder = 'ctest.p01.ctest.srv.nintendo.net';
		domainOpt.rmempty = false;

		o = s.option(form.Button, '_test_btn', _('Connection Self-Test'),
			_('Click Save & Apply first. The self-test checks the DNS redirect, the 2-byte HTTP response, port 80, and the firewall rules.'));
		o.inputtitle = _('Run Self-Test');
		o.inputstyle = 'apply';
		o.onclick = L.bind(function() {
			return this.handleTestSpoof(m, enableOpt, forceDhcpOpt, lanOpt, spoofOpt, domainOpt, fwModeOpt, isFw4, netDefaults);
		}, this);

		s = m.section(form.GridSection, 'device', _('Controlled Devices'),
			_('If a listed device uses Automatic (DHCP), it gets the Switch Helper IP as its DNS server. You can also block its internet access.'));
		s.addremove = true;
		s.anonymous = true;

		o = s.option(form.Value, 'name', _('Device Name'));
		o.placeholder = 'Switch2';
		o.rmempty = false;

		o = s.option(form.Value, 'mac', _('MAC Address'));
		o.datatype = 'macaddr';
		o.placeholder = '11:22:33:44:55:66';
		o.rmempty = false;

		o = s.option(form.Value, 'ip', _('Static IP (Optional)'),
			_('Leave blank for an automatic IP. The device still gets the Switch Helper IP as its DNS server.'));
		o.datatype = 'ip4addr';
		o.placeholder = netDefaults.prefix ? _('Auto-assign (e.g., %s.x)').format(netDefaults.prefix) : _('Auto-assign');
		o.rmempty = true;
		o.validate = function(section_id, value) {
			if (!value) return true;
			var lanVal = lanOpt.formvalue('global');
			var spoofVal = spoofOpt.formvalue('global');
			if (value === lanVal || value === spoofVal) {
				return _('The static IP must differ from the Router LAN IP and the Switch Helper IP.');
			}
			if (lanVal) {
				var p1 = lanVal.split('.').slice(0, 3).join('.');
				var p2 = value.split('.').slice(0, 3).join('.');
				if (p1 !== p2) {
					return _('Use a static IP in the same subnet as the Router LAN IP (%s.x).').format(p1);
				}
			}
			return true;
		};

		o = s.option(form.Flag, 'block_wan', _('Block Internet Access'),
			_('The firewall uses the MAC address to block ICMPv6 and all IPv4 and IPv6 forwarding. This stops updates that use hard-coded IP addresses.'));
		o.default = '1';
		o.rmempty = false;

		return m.render();
	}
});
