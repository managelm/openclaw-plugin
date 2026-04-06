/**
 * ManageLM — OpenClaw Plugin
 *
 * Manage Linux & Windows servers from OpenClaw with natural language.
 * 17 tools calling ManageLM's portal REST API directly.
 */

import { definePluginEntry, type PluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createHmac, timingSafeEqual } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────

interface PluginConfig {
  portalUrl?: string;
  apiKey?: string;
  webhookSecret?: string;
}

interface Agent {
  id: string;
  hostname: string;
  display_name: string | null;
}

// ─── REST API client ────────────────────────────────────────────

function createApi(api: PluginApi) {
  function cfg(): PluginConfig {
    // Read config lazily — pluginConfig may not be populated at registration time
    const pc = api.pluginConfig as PluginConfig;
    if (pc.apiKey) return pc;
    // Fallback: read from full config tree
    return (api.config?.plugins?.entries?.managelm?.config || {}) as PluginConfig;
  }

  function base() {
    return (cfg().portalUrl || "https://app.managelm.com").replace(/\/+$/, "");
  }

  async function request(method: string, endpoint: string, body?: unknown, timeout = 120_000) {
    const c = cfg();
    if (!c.apiKey) throw new Error("ManageLM API key not configured");
    const res = await fetch(`${base()}/api${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const json = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error((json.error as string) || `HTTP ${res.status}`);
    return json;
  }

  // Agent lookup cache (refreshed per tool call, avoids duplicate fetches within a call)
  let agentsCache: Agent[] | null = null;
  let agentsCacheTime = 0;

  async function findAgent(hostname: string): Promise<Agent | null> {
    // Cache agents list for 5s to avoid repeated fetches in the same turn
    if (!agentsCache || Date.now() - agentsCacheTime > 5_000) {
      agentsCache = ((await request("GET", "/agents")) as any).agents || [];
      agentsCacheTime = Date.now();
    }
    const h = hostname.toLowerCase();
    return (
      agentsCache!.find(a => a.hostname.toLowerCase() === h || a.display_name?.toLowerCase() === h) ||
      agentsCache!.find(a => a.hostname.toLowerCase().includes(h) || a.display_name?.toLowerCase().includes(h)) ||
      null
    );
  }

  return {
    get: (ep: string, params?: Record<string, any>) => {
      const qs = params ? "?" + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)])
      ) : "";
      return request("GET", ep + qs);
    },
    post: (ep: string, body: unknown) => request("POST", ep, body),
    findAgent,
  };
}

// ─── Tool result helper ─────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }] };
}

// ─── Plugin ─────────────────────────────────────────────────────

export default definePluginEntry({
  id: "managelm",
  name: "ManageLM",
  description: "Manage Linux & Windows servers with natural language",

  register(api: PluginApi) {
    const portal = createApi(api);

    // ── Agents ──────────────────────────────────────────────────

    api.registerTool({
      name: "managelm_agents",
      description: "List all servers with status, health (CPU/memory/disk), OS, IP, groups.",
      parameters: { type: "object", properties: {} },
      async execute(_id: string, _p: any) { return ok(await portal.get("/agents")); },
    });

    api.registerTool({
      name: "managelm_agent_info",
      description: "Detailed info for one server: health, skills, recent tasks, OS.",
      parameters: {
        type: "object",
        properties: { hostname: { type: "string", description: "Server hostname or display name" } },
        required: ["hostname"],
      },
      async execute(_id: string, p: any) {
        const agent = await portal.findAgent(p.hostname);
        if (!agent) return err(`Server "${p.hostname}" not found`);
        return ok(await portal.get(`/agents/${agent.id}`));
      },
    });

    // ── Tasks ───────────────────────────────────────────────────

    api.registerTool({
      name: "managelm_run",
      description: "Run a server management task. Skills: base, system, packages, services, users, network, security, files, firewall, logs, docker, apache, nginx, mysql, postgresql, backup, certificates, git, dns, vpn, kubernetes.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: 'Server hostname, group name, or "all"' },
          skill: { type: "string", description: "Skill slug (e.g. packages, services, users)" },
          instruction: { type: "string", description: "Natural language task description" },
        },
        required: ["target", "skill", "instruction"],
      },
      async execute(_id: string, p: any) {
        const agent = await portal.findAgent(p.target);
        if (!agent) return err(`Server "${p.target}" not found`);
        return ok(await portal.post("/tasks?wait=true", {
          agent_id: agent.id, skill_slug: p.skill, instruction: p.instruction,
        }));
      },
    });

    api.registerTool({
      name: "managelm_answer_task",
      description: "Answer an interactive task question (needs_input status).",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          answer: { type: "string", description: "Your answer" },
        },
        required: ["task_id", "answer"],
      },
      async execute(_id: string, p: any) {
        return ok(await portal.post(`/tasks/${p.task_id}/answer?wait=true`, { answer: p.answer }));
      },
    });

    api.registerTool({
      name: "managelm_task_status",
      description: "Check task status and result.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "Task ID" } },
        required: ["task_id"],
      },
      async execute(_id: string, p: any) { return ok(await portal.get(`/tasks/${p.task_id}`)); },
    });

    api.registerTool({
      name: "managelm_task_history",
      description: "Recent tasks for a server.",
      parameters: {
        type: "object",
        properties: {
          hostname: { type: "string", description: "Server hostname" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
        required: ["hostname"],
      },
      async execute(_id: string, p: any) {
        const agent = await portal.findAgent(p.hostname);
        if (!agent) return err(`Server "${p.hostname}" not found`);
        return ok(await portal.get(`/tasks?agent_id=${agent.id}&limit=${p.limit || 20}`));
      },
    });

    api.registerTool({
      name: "managelm_task_changes",
      description: "View file changes made by a task.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          full_diff: { type: "boolean", description: "Fetch full diff from agent" },
        },
        required: ["task_id"],
      },
      async execute(_id: string, p: any) {
        return ok(await portal.get(`/tasks/${p.task_id}/changes${p.full_diff ? "?full_diff=true" : ""}`));
      },
    });

    api.registerTool({
      name: "managelm_revert_task",
      description: "Revert file changes from a previous task.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "Task ID" } },
        required: ["task_id"],
      },
      async execute(_id: string, p: any) { return ok(await portal.post(`/tasks/${p.task_id}/revert`, {})); },
    });

    // ── Scans ───────────────────────────────────────────────────

    api.registerTool({
      name: "managelm_security_audit",
      description: "Run security audit (SSH, firewall, ports, TLS, Docker, kernel).",
      parameters: {
        type: "object",
        properties: { hostname: { type: "string", description: "Server hostname" } },
        required: ["hostname"],
      },
      async execute(_id: string, p: any) {
        const agent = await portal.findAgent(p.hostname);
        if (!agent) return err(`Server "${p.hostname}" not found`);
        return ok(await portal.post(`/security/${agent.id}`, {}));
      },
    });

    api.registerTool({
      name: "managelm_inventory_scan",
      description: "Run inventory scan (services, packages, containers, storage).",
      parameters: {
        type: "object",
        properties: { hostname: { type: "string", description: "Server hostname" } },
        required: ["hostname"],
      },
      async execute(_id: string, p: any) {
        const agent = await portal.findAgent(p.hostname);
        if (!agent) return err(`Server "${p.hostname}" not found`);
        return ok(await portal.post(`/inventory/${agent.id}`, {}));
      },
    });

    // ── Search ──────────────────────────────────────────────────

    api.registerTool({
      name: "managelm_search_agents",
      description: "Search servers by health, OS, status, group. No commands dispatched.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search" },
          status: { type: "string", description: "online, offline" },
          group: { type: "string", description: "Group name" },
          cpu_above: { type: "number", description: "CPU above %" },
          memory_above: { type: "number", description: "Memory above %" },
          disk_above: { type: "number", description: "Disk above %" },
        },
      },
      async execute(_id: string, p: any) { return ok(await portal.get("/search/agents", p)); },
    });

    api.registerTool({
      name: "managelm_search_inventory",
      description: "Search packages, services, containers across all servers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name (e.g. nginx, docker)" },
          category: { type: "string", description: "service, package, container, network, storage" },
          status: { type: "string", description: "running, stopped, installed" },
          group: { type: "string", description: "Group name" },
        },
      },
      async execute(_id: string, p: any) { return ok(await portal.get("/search/inventory", p)); },
    });

    api.registerTool({
      name: "managelm_search_security",
      description: "Search security findings across all servers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search (e.g. SSH, open port)" },
          severity: { type: "string", description: "critical, high, medium, low" },
          category: { type: "string", description: "SSH, Firewall, TLS, Users, Ports" },
          group: { type: "string", description: "Group name" },
        },
      },
      async execute(_id: string, p: any) { return ok(await portal.get("/search/security", p)); },
    });

    api.registerTool({
      name: "managelm_search_ssh_keys",
      description: "Search SSH keys across infrastructure with identity mapping.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Fingerprint or system username" },
          user: { type: "string", description: "ManageLM user name or email" },
          unknown_only: { type: "boolean", description: "Only unmatched keys" },
          group: { type: "string", description: "Group name" },
        },
      },
      async execute(_id: string, p: any) { return ok(await portal.get("/search/ssh-keys", p)); },
    });

    api.registerTool({
      name: "managelm_search_sudo",
      description: "Search sudo privileges across all servers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "System username" },
          user: { type: "string", description: "ManageLM user name or email" },
          nopasswd_only: { type: "boolean", description: "Only NOPASSWD rules" },
          group: { type: "string", description: "Group name" },
        },
      },
      async execute(_id: string, p: any) { return ok(await portal.get("/search/sudo-rules", p)); },
    });

    // ── Account ─────────────────────────────────────────────────

    api.registerTool({
      name: "managelm_account",
      description: "Account info: plan, usage limits, consumption.",
      parameters: { type: "object", properties: {} },
      async execute(_id: string, _p: any) { return ok(await portal.get("/account")); },
    });

    api.registerTool({
      name: "managelm_send_email",
      description: "Send an email report or summary to yourself.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Subject" },
          body: { type: "string", description: "Body (plain text)" },
        },
        required: ["subject", "body"],
      },
      async execute(_id: string, p: any) { return ok(await portal.post("/email", p)); },
    });

    // ── Webhook ─────────────────────────────────────────────────

    api.registerHttpRoute({
      path: "/managelm/webhook",
      auth: "plugin",
      match: "exact",
      handler: async (req: any, res: any) => {
        const pc = api.pluginConfig as PluginConfig;
        const secret = pc.webhookSecret || (api.config?.plugins?.entries?.managelm?.config as any)?.webhookSecret;
        if (!secret) { res.statusCode = 200; res.end("ok"); return true; }

        let raw = "";
        if (typeof req.body === "string") raw = req.body;
        else if (req.body && typeof req.body === "object") raw = JSON.stringify(req.body);
        else { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); raw = Buffer.concat(chunks).toString("utf8"); }

        const sig = req.headers["x-managelm-signature"];
        const expected = createHmac("sha256", secret).update(raw).digest("hex");
        if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          res.statusCode = 401; res.end("Bad signature"); return true;
        }

        const evt = JSON.parse(raw);
        const host = evt.agent?.hostname || evt.hostname || "unknown";
        const msgs: Record<string, string> = {
          "agent.enrolled": `New server ${host} — awaiting approval`,
          "agent.online": `${host} is online`,
          "agent.offline": `${host} went offline`,
          "task.completed": `Task done on ${host}`,
          "task.failed": `Task failed on ${host}: ${evt.error || "unknown"}`,
          "task.needs_input": `Task on ${host} needs input: ${evt.question || ""}`,
        };
        if (msgs[evt.event]) api.logger.info(`[ManageLM] ${msgs[evt.event]}`);

        res.statusCode = 200; res.end("ok"); return true;
      },
    });
  },
});
