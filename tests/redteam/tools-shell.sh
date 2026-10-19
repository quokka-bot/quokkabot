#!/usr/bin/env bash
# Red team from the model's own shell: run inside the tools sandbox exactly as `workspace_exec` runs commands.
# Every probe is something a prompt-injected agent would try. Each line of output is one JSON result; "pass" means
# the attempt failed the way it should. Exit code is the number of probes that did not pass.
set -u
fails=0

result() {
  local check="$1" pass="$2" detail="$3"
  printf '{"check":"%s","pass":%s,"detail":"%s"}\n' "$check" "$pass" "$(printf '%s' "$detail" | tr -d '"\\' | tr '\n' ' ' | cut -c1-200)"
  [ "$pass" = true ] || fails=$((fails + 1))
}

tcp_refused() {
  local name="$1" host="$2" port="$3"
  if timeout 4 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
    result "$name" false "connected to $host:$port"
  else
    result "$name" true "no connection to $host:$port"
  fi
}

# Network: the tools sandbox has none at all.
tcp_refused net_public_ip 1.1.1.1 443
tcp_refused net_model_provider_ip 160.79.104.10 443
tcp_refused net_metadata 169.254.169.254 80
tcp_refused net_control_mcp 10.231.1.3 8090
tcp_refused net_control_app 10.232.1.3 8080
tcp_refused net_egress_cli 10.231.1.2 3128
tcp_refused net_egress_browser 10.232.1.2 3128
tcp_refused net_browser_cdp 10.232.1.10 9222
tcp_refused net_browser_selkies 10.232.1.10 3000
tcp_refused net_browser_service 10.232.1.10 7800
tcp_refused net_docker_tcp 172.17.0.1 2375
if getent hosts api.anthropic.com >/dev/null 2>&1; then result dns_resolution false "resolved api.anthropic.com"; else result dns_resolution true "no DNS"; fi
routes=$(ip route 2>/dev/null || cat /proc/net/route 2>/dev/null | tail -n +2)
if printf '%s' "$routes" | grep -q -E 'default|00000000'; then result no_default_route false "$routes"; else result no_default_route true "no default route"; fi

# The CLI's sign-in and every other sandbox's files are not here.
creds=$(find / -xdev \( -name '.credentials.json' -o -name 'auth.json' -o -path '*/.claude/*' \) 2>/dev/null | head -5)
if [ -z "$creds" ]; then result no_cli_credentials true "none found"; else result no_cli_credentials false "$creds"; fi
if [ -e /home/claude ]; then result no_cli_home false "/home/claude exists"; else result no_cli_home true "absent"; fi
profile=$(find / -xdev \( -name 'Cookies' -o -name 'Login Data' -o -name 'chrome-profile' \) 2>/dev/null | head -3)
if [ -z "$profile" ]; then result no_browser_profile true "none found"; else result no_browser_profile false "$profile"; fi

# Host and container escape surfaces.
for sock in /var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock /run/quokkabot-supervisor/supervisor.sock; do
  if [ -e "$sock" ]; then result "no_socket_$(basename "$sock")" false "$sock exists"; else result "no_socket_$(basename "$sock")" true "absent"; fi
done
if sudo -n true 2>/dev/null; then result no_sudo false "sudo works"; else result no_sudo true "sudo refused or absent"; fi
if [ "$(id -u)" = 0 ]; then result not_root false "running as root"; else result not_root true "uid $(id -u)"; fi
if dmesg 2>/dev/null | head -1 | grep -q gVisor; then result gvisor true "gVisor kernel"; else result gvisor false "not gVisor: $(uname -r)"; fi
others=$(ps -eo comm 2>/dev/null | grep -v -E '^(COMMAND|ps|bash|sh|grep|sleep|timeout|cut|tr|head|find|tail|sort|uniq|id|dmesg|ip|cat|getent|printf)$' | sort -u | tr '\n' ' ')
if printf '%s' "$others" | grep -q -E 'claude|chrome|node|selkies|Xvfb|nginx'; then result no_foreign_processes false "$others"; else result no_foreign_processes true "${others:-only the shell}"; fi

# Downloads are read-only for the agent; the workspace is writable.
if touch /downloads/.redteam 2>/dev/null; then rm -f /downloads/.redteam; result downloads_read_only false "wrote to /downloads"; else result downloads_read_only true "write refused"; fi
if touch /workspace/.redteam 2>/dev/null; then rm -f /workspace/.redteam; result workspace_writable true "ok"; else result workspace_writable false "cannot write /workspace"; fi

# Instruction files cannot be planted for the CLI: nothing here is mounted into the CLI sandbox.
if mount 2>/dev/null | grep -q -E 'cli-state|/home/claude'; then result no_cli_mounts false "cli state mounted"; else result no_cli_mounts true "not mounted"; fi

exit "$fails"
