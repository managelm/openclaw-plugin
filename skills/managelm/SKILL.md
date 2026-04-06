---
name: managelm
description: Manage Linux and Windows servers via ManageLM — run tasks, search infrastructure, audit security, and control your fleet with natural language
---

# ManageLM

You can manage remote servers through ManageLM. Use the `managelm_*` tools below.

## Available tools

| Tool | Purpose |
|------|---------|
| `managelm_agents` | List all servers with status, health, OS, IP, groups |
| `managelm_agent_info` | Detailed info for one server (hostname param) |
| `managelm_run` | Run a task: target + skill + instruction |
| `managelm_answer_task` | Answer an interactive task question |
| `managelm_task_status` | Check task status by ID |
| `managelm_task_history` | Recent tasks for a server |
| `managelm_task_changes` | View file diffs from a task |
| `managelm_revert_task` | Undo file changes from a task |
| `managelm_security_audit` | Run security audit on a server |
| `managelm_inventory_scan` | Run inventory scan on a server |
| `managelm_search_agents` | Search servers by health, OS, status, group |
| `managelm_search_inventory` | Search packages, services, containers |
| `managelm_search_security` | Search security findings |
| `managelm_search_ssh_keys` | Search SSH keys with identity mapping |
| `managelm_search_sudo` | Search sudo privileges |
| `managelm_account` | Account info, plan, usage |
| `managelm_send_email` | Send email report to yourself |

## Running tasks with managelm_run

The `managelm_run` tool accepts:
- **target**: server hostname or display name
- **skill**: one of: base, system, packages, services, users, network, security, files, firewall, logs, docker, apache, nginx, mysql, postgresql, backup, certificates, git, dns, vpn, kubernetes
- **instruction**: plain English description

Example: `managelm_run(target="web-01", skill="packages", instruction="install nginx")`

## Workflow

1. Call `managelm_agents` to discover available servers
2. Call `managelm_run` with the target hostname, skill, and instruction
3. Use `managelm_search_*` tools for fast lookups across all servers
4. Use `managelm_security_audit` or `managelm_inventory_scan` for fresh data
