# Sourced after /lib/functions.sh and config_load. Output validated hostnames
# one per line; never split an unvalidated UCI value or emit a partial list.
switch2_test_domains() (
	local value
	domain_input() {
		# Reject control characters before producing the newline-delimited stream.
		case "$1" in ''|*[!A-Za-z0-9.-]*) exit 1 ;; esac
		printf '%s\n' "$1"
	}

	value=$(
		if [ "${CONFIG_global_test_domain_LENGTH:-0}" -gt 0 ]; then
			config_list_foreach global test_domain domain_input
		else
			domain_input "${CONFIG_global_test_domain-ctest.p01.ctest.srv.nintendo.net}"
		fi
	) || return 1

	printf '%s\n' "$value" | LC_ALL=C awk -F. '
		{
			if (NR > 8 || length($0) > 253 || seen[tolower($0)]++) bad=1
			for (i=1; i<=NF; i++)
				if ($i !~ /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/ || length($i)>63) bad=1
			line[NR]=$0
		}
		END {
			if (bad || !NR) exit 1
			for (i=1; i<=NR; i++) print line[i]
		}'
)
