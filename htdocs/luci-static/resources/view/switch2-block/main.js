'use strict';
'require view';
'require form';
'require uci';
'require fs';
'require ui';
'require rpc';

var config = 'switch2-block';
var defaultDomain = 'ctest.p01.ctest.srv.nintendo.net';
var getLanAddresses = rpc.declare({
	object: 'network.interface.lan', method: 'status', expect: { 'ipv4-address': [] }
});
var getPending = rpc.declare({ object: 'uci', method: 'changes', reject: true });

function validLocalIP(value) {
	if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value))
		return false;
	var octets = value.split('.').map(Number);
	return octets[0] > 0 && octets[0] !== 127 && octets[0] < 224 &&
		octets.every(function(octet) { return octet <= 255; });
}

function domainList(value) {
	return Array.isArray(value) ? value : [ value == null ? defaultDomain : value ];
}

function sameDomains(a, b) {
	return a.length === b.length && a.every(function(value, i) { return value === b[i]; });
}

function validateDomain(value) {
	if (typeof value === 'string' && value.length <= 253 && value.split('.').every(function(label) {
		return label.length > 0 && label.length <= 63 &&
			!/[^A-Za-z0-9-]/.test(label) && label[0] !== '-' && label[label.length - 1] !== '-';
	}))
		return true;
	return _('Enter a valid DNS hostname using ASCII letters, digits, hyphens and dots.');
}

function validateDomains(values) {
	if (!values.length || values.length > 8)
		return _('Enter between one and eight connection test domains.');

	var seen = new Set();
	for (var i = 0; i < values.length; i++) {
		var result = validateDomain(values[i]);
		if (result !== true)
			return result;
		var hostname = values[i].toLowerCase();
		if (seen.has(hostname))
			return _('Connection test domains must be unique regardless of letter case.');
		seen.add(hostname);
	}
	return true;
}

// Called after LuCI has parsed every row, but before it saves anything to rpcd.
function validateEnrollment() {
	if (uci.get(config, 'global', 'enabled') !== '1')
		return;

	var devices = uci.sections(config, 'device'), seen = new Set();
	if (!devices.length)
		throw new Error(_('Enroll at least one real adapter MAC address before enabling isolation.'));

	if (!validLocalIP(uci.get(config, 'global', 'lan_ip')) || !validLocalIP(uci.get(config, 'global', 'spoof_ip')))
		throw new Error(_('Enter a valid unicast IPv4 address for both the router LAN and the local helper.'));

	devices.forEach(function(dev) {
		var mac = String(dev.mac || '').toUpperCase();
		// The old 11:22:33:44:55:66 example is multicast, not an adapter address.
		if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ||
		    (parseInt(mac.slice(0, 2), 16) & 1) || mac === '00:00:00:00:00:00' || mac === '00:11:22:33:44:55')
			throw new Error(_('Enter a real, nonzero unicast MAC address for every adapter.'));
		if (seen.has(mac))
			throw new Error(_('Duplicate adapter MAC address: %s').format(mac));
		seen.add(mac);
		if (dev.block_wan != null && dev.block_wan !== '1')
			throw new Error(_('Enroll every listed adapter for blocking or remove its row.'));
	});
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load(config),
			L.resolveDefault(getLanAddresses(), [])
		]);
	},

	detectNetworkDefaults: function(addresses) {
		var detectedLanIp = addresses.length && validLocalIP(addresses[0].address) ? addresses[0].address : '';
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

	handleSave: function() {
		return this.map.save(validateEnrollment);
	},

	runTest: function(checkDisplayed) {
		ui.showModal(_('Running the Self-Test...'), [
			E('p', { 'class': 'spinning' }, _('Checking the router-local helper and active isolation policy.'))
		]);
		return checkDisplayed().then(function() {
			return fs.exec('/usr/libexec/switch2-block/test.sh');
		}).then(function(res) {
			return checkDisplayed().then(function() {
				var lines = (res.stdout || '').trim().split('\n');
				var complete = lines[lines.length - 1] === '[switch2-block:complete]';
				if (complete) lines.pop();
				var ok = res.code === 0 && complete && !res.stderr;
				ui.showModal(_('Self-Test Results'), [
					E('strong', {}, ok
						? _('Router-local checks passed for the committed adapter list.')
						: _('Isolation or helper checks failed or could not be verified.')),
					E('p', {}, _('This is a snapshot on the router, not a test from the console. It cannot verify adapter ownership, peer isolation, hardware bypasses or other networks.')),
					E('p', {}, _('On the isolated network, test each Wi-Fi and dock adapter from the console. Verify the local connection test works and external IPv4 and IPv6 traffic cannot pass.')),
					E('pre', {}, [ document.createTextNode(lines.join('\n') + (res.stderr ? '\n' + res.stderr : '')) ]),
					E('div', { 'class': 'right' }, E('button', {
						'class': 'btn cbi-button-neutral', 'click': ui.hideModal
					}, _('Close')))
				]);
			});
		}).catch(function(err) {
			ui.hideModal();
			ui.addNotification(null, E('p', {}, [ document.createTextNode(_('Could not run the self-test: %s').format(err.message)) ]), 'error');
		});
	},
	render: function(data) {
		var netDefaults = this.detectNetworkDefaults(data[1]);
		var m, s, devices, o, enableOpt, lanOpt, spoofOpt, domainOpt;

		this.map = m = new form.Map(config, _('Nintendo Switch 2: Connection Spoofing and Update Blocking'),
			_('Use this OpenWrt router as the only gateway for the console. Isolate it from LAN peers and alternate gateways with a dedicated network and client isolation. Disable software and hardware flow offloading and vendor acceleration. A secondary DNS or DHCP server cannot enforce isolation.') + '<br/>' +
			_('Enroll every Wi-Fi and dock/Ethernet adapter MAC, including any randomized address actually used. Traffic that bypasses this router or uses an unlisted address is not blocked.'));

		s = m.section(form.NamedSection, 'global', 'global', _('Network Isolation'));
		s.anonymous = true;

		enableOpt = s.option(form.Flag, 'enabled', _('Enable Spoofing and Update Blocking'),
			_('If the enabled policy cannot be restored at early boot, normal router network startup is held. Use a local console or failsafe to repair it or explicitly disable isolation. Disabling it removes protection for all enrolled adapters.'));
		enableOpt.rmempty = false;

		lanOpt = s.option(form.Value, 'lan_ip', _('Router LAN IP'),
			_('The main dnsmasq and LuCI use this IP. The app detects it from the LAN interface.'));
		lanOpt.datatype = 'ip4addr';
		if (netDefaults.lanIp) {
			lanOpt.default = netDefaults.lanIp;
			lanOpt.placeholder = netDefaults.lanIp;
		}
		lanOpt.rmempty = true;

		spoofOpt = s.option(form.Value, 'spoof_ip', _('Switch Helper IP'),
			_('Choose an unused IPv4 address in the router LAN subnet, outside the DHCP pool. The helper will bind to it on br-lan.'));
		spoofOpt.datatype = 'ip4addr';
		if (netDefaults.spoofIp) {
			spoofOpt.placeholder = netDefaults.spoofIp;
		}
		spoofOpt.rmempty = true;
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

		domainOpt = s.option(form.DynamicList, 'test_domain', _('Nintendo Connection Test Domains'),
			_('Enter one to eight domains. The default is ctest.p01.ctest.srv.nintendo.net.'));
		domainOpt.placeholder = defaultDomain;
		domainOpt.rmempty = false;
		// The add box is optional; parse() still requires a nonempty saved list.
		domainOpt.validate = function(id, value) { return value === '' || validateDomain(value); };

		// DynamicList's getValue() can omit invalid, whitespace-only or duplicate
		// text still in the add box. Read it directly for validation and comparison.
		function readDomainDraft(id) {
			var node = domainOpt.getUIElement(id).node;
			return {
				items: Array.from(node.querySelectorAll('.item > input[type="hidden"]'), function(input) {
					return input.value;
				}),
				pending: node.querySelector('.add-item > input[type="text"]').value
			};
		}
		var domainDraft, renderDomainWidget = domainOpt.renderWidget;
		domainOpt.renderWidget = function(id, index, value) {
			// Wrap legacy scalars explicitly: LuCI otherwise splits them on whitespace.
			var node = renderDomainWidget.call(this, id, index, domainDraft ? domainDraft.items : domainList(value));
			if (domainDraft)
				node.querySelector('.add-item > input[type="text"]').value = domainDraft.pending;
			return node;
		};
		domainOpt.formvalue = function(id) {
			var draft = readDomainDraft(id);
			if (draft.pending !== '') draft.items.push(draft.pending);
			return draft.items;
		};
		domainOpt.parse = function(id) {
			var values = this.formvalue(id), result = validateDomains(values);
			if (result !== true)
				return Promise.reject(new Error(result));
			var saved = this.cfgvalue(id);
			// An unchanged legacy scalar still needs to become a list on Save.
			if (!Array.isArray(saved) || !sameDomains(values, saved))
				this.write(id, values);
			return Promise.resolve();
		};

		o = s.option(form.Button, '_test_btn', _('Connection Self-Test'),
			_('Click Save & Apply first. The self-test checks local DNS and the exact HTTP response for each configured domain, the listener and the active isolation policy for all enrolled MACs.'));
		o.inputtitle = _('Run Self-Test');
		o.onclick = L.bind(function() { return this.runTest(checkDisplayed); }, this);

		devices = m.section(form.TableSection, 'device', _('Enrolled adapters'),
			_('Add a row for each real adapter. Blocking is required for every row. For a previously unchecked adapter, check its enrollment box or remove its row.'));
		devices.addremove = true;
		devices.anonymous = true;

		var nameOpt = devices.option(form.Value, 'name', _('Device Name'));
		nameOpt.placeholder = 'Switch2';

		var macOpt = devices.option(form.Value, 'mac', _('MAC Address'));
		macOpt.datatype = 'macaddr';
		macOpt.rmempty = false;

		o = devices.option(form.Value, 'ip', _('Static IP (Optional)'),
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

		var blockOpt = devices.option(form.Flag, 'block_wan', _('Enroll for blocking (required)'));
		blockOpt.default = '1';
		blockOpt.rmempty = false;

		var globalFields = [enableOpt, lanOpt, spoofOpt];
		var adapterFields = [nameOpt, macOpt, o, blockOpt];

		// TableSection normally stages UCI on row edits. Keep incomplete rows in
		// the browser; only Save may validate and stage the whole adapter list.
		function keepDraft(fields, id) {
			fields.forEach(function(field) {
				uci.set(config, id, field.option, field.formvalue(id));
			});
		}
		function editRows(removeId) {
			domainDraft = readDomainDraft('global');
			keepDraft(globalFields, 'global');
			devices.cfgsections().forEach(function(id) {
				if (id !== removeId) keepDraft(adapterFields, id);
			});
			if (removeId != null) uci.remove(config, removeId);
			else uci.add(config, 'device');
			return m.render().finally(function() { domainDraft = null; });
		}
		devices.handleAdd = function() { return editRows(null); };
		devices.handleRemove = editRows;

		function fieldsMatch(fields, id, saved) {
			return fields.every(function(field) {
				var value = saved[field.option];
				if (value == null) value = field.default || '';
				return String(field.formvalue(id) || '') === String(value);
			});
		}
		function checkDisplayed() {
			// Fetch fresh rpcd data without replacing unsaved local form values.
			return Promise.all([getPending(), uci.callLoad(config)]).then(function(res) {
				var changes = res[0].changes, saved = res[1], ids = devices.cfgsections();
				var changed = Object.keys(changes).some(function(key) { return changes[key].length > 0; });
				var savedIds = Object.keys(saved).filter(function(id) { return saved[id]['.type'] === 'device'; });
				if (changed || !saved.global || !fieldsMatch(globalFields, 'global', saved.global) ||
				    !sameDomains(domainOpt.formvalue('global'), domainList(saved.global.test_domain)) ||
				    ids.length !== savedIds.length || !ids.every(function(id) {
					    return savedIds.indexOf(id) !== -1 && fieldsMatch(adapterFields, id, saved[id]);
				    }))
					throw new Error(_('Settings are pending, unsaved or no longer match this page. Save & Apply or reload before testing.'));
				if (saved.global.enabled !== '1')
					throw new Error(_('Isolation is disabled.'));
				validateEnrollment();
			});
		}

		return m.render();
	}
});
