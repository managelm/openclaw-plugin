<p align="center">
  <a href="https://www.managelm.com">
    <img src="https://www.managelm.com/assets/ManageLM.png" alt="ManageLM" height="50">
  </a>
</p>

<h3 align="center">OpenClaw Plugin</h3>

<p align="center">
  Manage Linux &amp; Windows servers from OpenClaw using natural language.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
  <a href="https://www.managelm.com"><img src="https://img.shields.io/badge/website-managelm.com-cyan" alt="Website"></a>
  <a href="https://www.managelm.com/plugins/openclaw.html"><img src="https://img.shields.io/badge/docs-full%20documentation-green" alt="Docs"></a>
</p>

---

The ManageLM plugin for OpenClaw gives the OpenClaw agent the same tools ManageLM gives Claude through MCP, except the search of scheduled tasks: run tasks, search your fleet, run scans, act on cloud VMs, and more, all through natural language.

## Features

- **34 built-in tools** — modelled on the ManageLM MCP tools, with a `managelm_` prefix: tasks, scans, 13 fleet searches, hosting connectors and actions, task history and revert
- **Interactive tasks** — when the agent needs input, OpenClaw asks you and answers the task
- **Scans that wait** — security, inventory, access, certificate and activity scans return their result within 3 minutes, or status `running` after that
- **Cross-infrastructure search** — agents, inventory, security issues, activity, SSH keys, sudo, certificates, monitors, backups, credentials, keystore, cloud resources
- **Webhook receiver** — signed ManageLM events logged in the OpenClaw gateway

## Quick Start

### 1. Install

```bash
openclaw plugins install managelm
```

### 2. Configure

In the ManageLM portal, go to **Settings > MCP & API > API Keys** and create a key. It acts as you, limited to the authorizations you tick: add **Reports** for scans, **Hosting** for VM actions, **Credentials** / **Keystore** to search those.

```bash
# Set your API key
openclaw config set plugins.entries.managelm.config.apiKey "mlm_ak_your_key"

# Trust the plugin and enable tools
openclaw config set plugins.allow '["managelm"]'
openclaw config set tools.allow '["managelm"]'
openclaw config set tools.profile "full"
```

Self-hosted portals:

```bash
openclaw config set plugins.entries.managelm.config.portalUrl "https://portal.example.com"
```

### 3. Use it

```
> List my servers
> Install nginx on web-prod-1
> Which servers have CPU above 80%?
> Run a security audit on db-primary
> Who has SSH access to production servers?
> Who logged in to db-primary yesterday?
> Which certificates expire this month?
```

## Tools (34)

| Tool | Description |
|------|-------------|
| `managelm_search_agents` | Servers by status, group, site, health or text |
| `managelm_get_agent_info` | One server: OS, health, skills, recent tasks |
| `managelm_get_agent_skills` / `managelm_list_available_skills` | Skills on a server / catalog skills not yet imported |
| `managelm_get_account_info` / `managelm_list_team_members` | Account, groups and sites / team members |
| `managelm_search_inventory` / `managelm_search_security` / `managelm_search_activity` | Inventory, security issues (audits, pentests, threats), logins and sudo |
| `managelm_search_ssh_keys` / `managelm_search_sudo_rules` | Access across the fleet, mapped to your team |
| `managelm_search_certificates` / `managelm_search_pki` | Certificates found on servers / certificates ManageLM issues |
| `managelm_search_monitors` / `managelm_search_backups` | Monitors with current status / backups and their last run |
| `managelm_search_credentials` / `managelm_search_keystore` | Rotating credentials / keystore keys and usage (metadata only) |
| `managelm_list_connectors` / `managelm_search_cloud` / `managelm_get_cloud_info` | Hosting connectors and the resources they discover |
| `managelm_cloud_action` | Start, stop, reboot or snapshot a VM (disruptive actions need your confirmation) |
| `managelm_run_security_audit` / `managelm_run_inventory_scan` / `managelm_run_access_scan` / `managelm_run_certificate_scan` / `managelm_run_activity_scan` | Run a scan on one server and wait for the result |
| `managelm_run_task` | Run a skill-based task on one server (`auto` lets the agent pick the skill) |
| `managelm_answer_task` / `managelm_follow_up_task` | Answer a task waiting for input / continue a conversation |
| `managelm_get_task_status` / `managelm_get_task_history` / `managelm_get_task_changes` / `managelm_revert_task` | Task results, history, file changes and revert |
| `managelm_send_email` | Email yourself a report |

Tasks wait up to 2 minutes; a longer one returns its task ID to check later. Scans wait up to 3 minutes; a longer one comes back with status `running`, and its result shows up in the matching `managelm_search_*` tool once it completes. Tasks and scans run on one server at a time. Approving agents, users, API keys and webhooks are managed in the portal.

## Webhook events

The plugin registers `/managelm/webhook` on the OpenClaw gateway and logs each ManageLM event it receives (servers going offline, failed tasks, monitors down, certificate renewals, ...).

Webhooks are created by an admin in the portal:

1. Go to **Settings > MCP & API > Webhooks**, add a webhook to `https://<your-gateway>/managelm/webhook`, choose the event categories and set an **HMAC secret**
2. Set the same secret in the plugin:

```bash
openclaw config set plugins.entries.managelm.config.webhookSecret "your_webhook_secret"
```

Every delivery is checked against its `X-Webhook-Signature` (HMAC-SHA256), and one sent more than 5 minutes ago is refused, so a captured delivery cannot be replayed. A repeat of a delivery already received in those 5 minutes is answered `200` and not logged again. A refused delivery counts as a failure on the portal, which disables a webhook after repeated failures: keep the gateway's clock synchronized. Without a secret configured, deliveries are refused, so a misconfiguration shows up as failed deliveries in the portal.

## Architecture

```
OpenClaw Agent ── REST API ──> ManageLM Portal ── WebSocket ──> Agent on Server
  (34 tools)                   (cloud control      (outbound      (skill exec)
                                plane)              only)
```

## Requirements

- **OpenClaw** with gateway running
- **ManageLM account** — [sign up free](https://app.managelm.com/register) (up to 10 agents)
- **ManageLM Agent** — on each managed server
- **API Key** — created by any user in Portal > Settings > MCP & API

## Other Integrations

- [Claude Code Extension](https://github.com/managelm/claude-extension) — MCP integration for Claude
- [VS Code Extension](https://github.com/managelm/vscode-extension) — `@managelm` in Copilot Chat
- [ChatGPT Plugin](https://github.com/managelm/openai-gpt) — manage servers from ChatGPT
- [n8n Plugin](https://github.com/managelm/n8n-plugin) — infrastructure automation workflows
- [Slack Plugin](https://github.com/managelm/slack-plugin) — notifications and commands in Slack

## Links

- [Website](https://www.managelm.com)
- [Full Documentation](https://www.managelm.com/plugins/openclaw.html)
- [Portal](https://app.managelm.com)

## License

[Apache 2.0](LICENSE)
