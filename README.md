# ManageLM — OpenClaw Plugin

Manage your Linux and Windows servers from OpenClaw using natural language.

## Install

```bash
openclaw plugins install managelm
```

## Setup

```bash
# 1. Set your API key (from Portal > Settings > MCP & API)
openclaw config set plugins.entries.managelm.config.apiKey "mlm_ak_your_key"

# 2. Trust the plugin
openclaw config set plugins.allow '["managelm"]'

# 3. Enable tools for the agent
openclaw config set tools.allow '["managelm"]'
openclaw config set tools.profile "full"

# 4. Restart the gateway
```

Self-hosted portals — also set:

```bash
openclaw config set plugins.entries.managelm.config.portalUrl "https://portal.example.com"
```

## Tools (17)

### Server management

| Tool | Description |
|------|-------------|
| `managelm_agents` | List all servers with status, health, OS, IP |
| `managelm_agent_info` | Detailed info for one server |
| `managelm_run` | Run a task (skill + target + instruction) |
| `managelm_answer_task` | Answer an interactive task question |

### Task tracking

| Tool | Description |
|------|-------------|
| `managelm_task_status` | Check task status |
| `managelm_task_history` | Recent tasks for a server |
| `managelm_task_changes` | View file diffs from a task |
| `managelm_revert_task` | Undo file changes |

### Audits & scans

| Tool | Description |
|------|-------------|
| `managelm_security_audit` | Run security audit |
| `managelm_inventory_scan` | Run inventory scan |

### Search (read-only, no commands dispatched)

| Tool | Description |
|------|-------------|
| `managelm_search_agents` | Search by health, OS, status, group |
| `managelm_search_inventory` | Search packages, services, containers |
| `managelm_search_security` | Search security findings |
| `managelm_search_ssh_keys` | Search SSH keys |
| `managelm_search_sudo` | Search sudo privileges |

### Utility

| Tool | Description |
|------|-------------|
| `managelm_account` | Account info, plan, usage |
| `managelm_send_email` | Send email report |

## Example usage

```
> List my servers
> Install nginx on web-prod-1
> Which servers have CPU above 80%?
> Run a security audit on db-primary
> Show me all critical security findings
> Who has SSH access to production servers?
```

## How it works

```
OpenClaw                      ManageLM Portal            Agent (on host)
┌──────────────────┐  REST    ┌──────────────┐   WS     ┌──────────────┐
│  Agent (LLM)     │ ───────► │  Portal API  │ ───────► │  Local LLM   │
│  Plugin (17)     │ ◄─────── │  /api/       │ ◄─────── │  (executes)  │
└──────────────────┘          └──────────────┘          └──────────────┘
```

## Webhooks (optional)

```bash
openclaw config set plugins.entries.managelm.config.webhookSecret "whsec_..."
```

Point a ManageLM webhook to your gateway's `/managelm/webhook`.

## Requirements

- **OpenClaw** with gateway running
- **ManageLM Portal** — [managelm.com](https://www.managelm.com) or self-hosted
- **ManageLM Agent** — on each managed server
- **API Key** — from Portal > Settings > MCP & API

## Links

- [ManageLM](https://www.managelm.com)
- [Docs](https://www.managelm.com/doc/)
- [GitHub](https://github.com/managelm/openclaw-plugin)

## License

[Apache 2.0](LICENSE)
