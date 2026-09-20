---
name: managelm
description: Manage Linux and Windows servers via ManageLM — run tasks, search infrastructure, audit security, and control your fleet with natural language
---

# ManageLM

You can manage remote servers through ManageLM. Use the `managelm_*` tools below: they are the ManageLM MCP tools with a `managelm_` prefix.

## Available tools

| Tool | Purpose |
|------|---------|
| `managelm_search_agents` | Servers by status, group, site, health metrics or text |
| `managelm_get_agent_info` | One server: OS, health, skills, recent tasks |
| `managelm_get_agent_skills` | Skills assigned to a server |
| `managelm_list_available_skills` | Catalog skills not yet imported |
| `managelm_get_account_info` | Account, groups and sites |
| `managelm_list_team_members` | Team members, roles, permissions, SSH key status |
| `managelm_search_inventory` | Services, packages, containers across servers |
| `managelm_search_security` | Security issues from audits, pentests and threat alerts |
| `managelm_search_activity` | Logins, failed logins, sudo commands, file changes |
| `managelm_search_ssh_keys` | SSH keys mapped to team members |
| `managelm_search_sudo_rules` | Sudo rules and Windows administrators |
| `managelm_search_certificates` | Certificates found on servers by certificate scans |
| `managelm_search_pki` | Certificates ManageLM issues and renews |
| `managelm_search_monitors` | Monitors with their current status |
| `managelm_search_backups` | Backups with their last run |
| `managelm_search_credentials` | Rotating credentials (metadata only) |
| `managelm_search_keystore` | Keystore keys, applications and usage (metadata only) |
| `managelm_list_connectors` | Hosting connectors |
| `managelm_search_cloud` | VMs, volumes, networks discovered by connectors |
| `managelm_get_cloud_info` | One hosting resource and the actions it allows |
| `managelm_cloud_action` | Start, shut down, reboot or snapshot a VM |
| `managelm_run_security_audit` | Security audit on one server (waits for the result) |
| `managelm_run_inventory_scan` | Inventory scan on one server |
| `managelm_run_access_scan` | SSH keys and sudo rules scan on one server |
| `managelm_run_certificate_scan` | Certificate discovery on one server |
| `managelm_run_activity_scan` | Activity scan (last 24 hours) on one server |
| `managelm_run_task` | Run a task: hostname + skill + instruction |
| `managelm_answer_task` | Answer a task waiting for input |
| `managelm_follow_up_task` | Continue the conversation of a completed task |
| `managelm_get_task_status` | Status and result of a task |
| `managelm_get_task_history` | Recent tasks on a server |
| `managelm_get_task_changes` | Files changed by a task, with diff |
| `managelm_revert_task` | Undo the file changes of a task |

## Running tasks

`managelm_run_task` takes:
- **hostname**: server hostname or display name (one server)
- **skill**: a skill assigned to that server. Call `managelm_get_agent_skills` to see them, or pass `auto` to let the agent choose. Common skills: base, system, packages, services, users, network, security, files, firewall, logs, containers, webserver, database, certificates, backup, dns, vpn, storage
- **instruction**: what to do, in plain language

Example: `managelm_run_task(hostname="web-01", skill="packages", instruction="install nginx")`

A task that takes longer than 2 minutes returns `status: "running"` with its `task_id`: check it later with `managelm_get_task_status`. A task in `needs_input` status carries a question: ask the user, then call `managelm_answer_task`.

## Workflow

1. Call `managelm_search_agents` to discover servers
2. For questions about the fleet (what runs where, security issues, logins, certificates, monitors, backups), prefer the `managelm_search_*` tools: they read stored data and run nothing on the servers
3. To change or inspect something live, call `managelm_run_task`
4. Use the `managelm_run_*` scans for fresh data on one server
5. Disruptive hosting actions and task reverts change production systems: confirm with the user first

Tasks and scans run on one server at a time. Approving agents, users, API keys and webhooks are managed in the ManageLM portal.
