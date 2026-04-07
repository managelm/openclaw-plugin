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

The ManageLM plugin for OpenClaw provides 17 tools for managing your infrastructure directly from the OpenClaw agent. Run tasks, search your fleet, trigger audits, and more — all through natural language.

## Quick Start

### 1. Install

```bash
openclaw plugins install managelm
```

### 2. Configure

```bash
# Set your API key (from Portal > Settings > MCP & API)
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
```

## Tools (17)

### Server Management

| Tool | Description |
|------|-------------|
| `managelm_agents` | List all servers with status, health, OS, IP |
| `managelm_agent_info` | Detailed info for one server |
| `managelm_run` | Run a task (skill + target + instruction) |
| `managelm_answer_task` | Answer an interactive task question |

### Task Tracking

| Tool | Description |
|------|-------------|
| `managelm_task_status` | Check task status |
| `managelm_task_history` | Recent tasks for a server |
| `managelm_task_changes` | View file diffs from a task |
| `managelm_revert_task` | Undo file changes |

### Audits & Scans

| Tool | Description |
|------|-------------|
| `managelm_security_audit` | Run security audit |
| `managelm_inventory_scan` | Run inventory scan |

### Search (read-only)

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

## Architecture

```
OpenClaw Agent ── REST API ──> ManageLM Portal ── WebSocket ──> Agent on Server
  (17 tools)                   (cloud control      (outbound      (local LLM,
                                plane)              only)          skill exec)
```

## Requirements

- **OpenClaw** with gateway running
- **ManageLM account** — [sign up free](https://app.managelm.com/register) (up to 10 agents)
- **ManageLM Agent** — on each managed server
- **API Key** — from Portal > Settings > MCP & API

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
