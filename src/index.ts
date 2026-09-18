/**
 * ManageLM — OpenClaw Plugin
 *
 * Manage Linux & Windows servers from OpenClaw with natural language.
 *
 * Tools are named `managelm_<tool>` after the ManageLM MCP server's tools and
 * behave the same way, through the portal REST API. The API key reaches the
 * same features as MCP (tasks, scans, searches, hosting actions); approving
 * agents, users, keys and webhooks are managed in the portal. Where the API is
 * narrower than MCP — tasks and scans take one server rather than a group, a
 * site or "all" — the tool description says so.
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
  status: string;
}

type Json = Record<string, any>;

/** How long the portal waits for a task before answering "still running". */
const TASK_WAIT_SECONDS = 120;

/**
 * Calls the portal answers only once the agent or hypervisor has: a revert
 * and a Proxmox action wait up to 60 s, a full diff 30 s. A shorter client
 * timeout reports a failure for an action that went through, and the model
 * retries it (a second reboot, a duplicate snapshot).
 */
const SLOW_CALL_TIMEOUT_MS = 90_000;

/** Deliveries older or newer than this are refused: a captured one cannot be replayed later. */
const WEBHOOK_MAX_AGE_MS = 5 * 60_000;

/**
 * Signatures of deliveries accepted within the window, so one captured inside
 * it cannot be replayed either; a portal retry of a delivery that did arrive is
 * the same body and is dropped too. Pruned on each delivery and capped.
 */
const seenDeliveries = new Map<string, number>();
const MAX_SEEN_DELIVERIES = 10_000;

/** True when this signature was already accepted within the window; records it otherwise. */
function isReplay(signature: string, now: number): boolean {
  for (const [sig, at] of seenDeliveries) {
    if (now - at <= WEBHOOK_MAX_AGE_MS) break;   // Map keeps insertion order: the rest is newer
    seenDeliveries.delete(sig);
  }
  if (seenDeliveries.has(signature)) return true;
  if (seenDeliveries.size >= MAX_SEEN_DELIVERIES) seenDeliveries.delete(seenDeliveries.keys().next().value!);
  seenDeliveries.set(signature, now);
  return false;
}

/** Scan type → portal route and the key its result comes back under. */
const SCANS: Record<string, { route: string; key: string }> = {
  security: { route: "security", key: "audit" },
  inventory: { route: "inventory", key: "inventory" },
  access: { route: "sshkeys", key: "scan" },
  certificates: { route: "certscan", key: "scan" },
  activity: { route: "activity", key: "audit" },
};

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

  async function request(method: string, endpoint: string, body?: unknown, timeout = 30_000): Promise<Json> {
    const c = cfg();
    if (!c.apiKey) throw new Error("ManageLM API key not configured");
    const res = await fetch(`${base()}/api${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    // Handle non-JSON responses (e.g. 502 HTML from a reverse proxy) — without
    // this, res.json() throws a cryptic parse error instead of the real cause.
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error(res.ok ? "Unexpected non-JSON response from portal" : `HTTP ${res.status} (non-JSON response)`);
    }
    const json = await res.json() as Json;
    if (!res.ok) throw new Error((json.error as string) || `HTTP ${res.status}`);
    return json;
  }

  function query(params?: Json): string {
    if (!params) return "";
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]),
    ).toString();
    return qs ? `?${qs}` : "";
  }

  // Agent lookup cache (5s, avoids repeated fetches within one turn)
  let agentsCache: Agent[] | null = null;
  let agentsCacheTime = 0;

  /**
   * Resolve a hostname or display name to exactly one agent (case-insensitive).
   * Like the MCP server, a partial name is never taken as a match: "web" could
   * be web01 or web02, and a task would run on whichever the list returned
   * first. Near matches come back as suggestions instead.
   */
  async function findAgent(hostname: string): Promise<{ agent: Agent } | { error: string }> {
    if (!agentsCache || Date.now() - agentsCacheTime > 5_000) {
      // The light list (id, names, status) is all resolution needs.
      agentsCache = (await request("GET", "/agents?view=basic")).agents || [];
      agentsCacheTime = Date.now();
    }
    const h = hostname.toLowerCase();
    const exact = agentsCache!.filter(a => a.hostname.toLowerCase() === h || a.display_name?.toLowerCase() === h);
    if (exact.length === 1) return { agent: exact[0] };
    if (exact.length > 1) {
      return { error: `"${hostname}" names ${exact.length} servers (${exact.map(a => a.hostname).join(", ")}). Use the full hostname.` };
    }
    const near = agentsCache!.filter(a => a.hostname.toLowerCase().includes(h) || a.display_name?.toLowerCase().includes(h));
    if (near.length > 0) {
      return { error: `No server is named "${hostname}". Did you mean: ${near.slice(0, 5).map(a => a.hostname).join(", ")}?` };
    }
    return { error: `No server is named "${hostname}". Use managelm_search_agents to list servers.` };
  }

  /** Poll a scan's result until it leaves running/pending, like the MCP run_* tools. */
  async function runScanAndWait(type: string, agentId: string, timeoutMs = 180_000): Promise<Json | null> {
    const scan = SCANS[type];
    await request("POST", `/${scan.route}/${agentId}`, {});
    const deadline = Date.now() + timeoutMs;
    let latest: Json | null = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      latest = (await request("GET", `/${scan.route}/${agentId}`))[scan.key] ?? null;
      if (latest && latest.status !== "running" && latest.status !== "pending") break;
    }
    return latest;
  }

  return {
    get: (ep: string, params?: Json, timeout?: number) => request("GET", ep + query(params), undefined, timeout),
    post: (ep: string, body: unknown = {}, timeout?: number) => request("POST", ep, body, timeout),
    /** Task dispatch: waits up to TASK_WAIT_SECONDS on the portal side. */
    postTask: (ep: string, body: unknown) =>
      request("POST", `${ep}?wait_seconds=${TASK_WAIT_SECONDS}`, body, (TASK_WAIT_SECONDS + 15) * 1000),
    findAgent,
    runScanAndWait,
  };
}

// ─── Tool result helpers ────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }] };
}

/** What the model reads after a task: its result, its question, or that it is still running. */
function taskOutcome(outcome: Json) {
  if (outcome.still_running) {
    return ok({
      task_id: outcome.task_id, status: "running",
      message: "The task is still running. Tell the user, including its task ID, and check it later with managelm_get_task_status.",
    });
  }
  const { task, result } = outcome;
  if (task.status === "needs_input") {
    return ok({
      task_id: task.id, status: "needs_input",
      question: task.question || "The agent needs more information to continue.",
      message: "Ask the user this question, then call managelm_answer_task with this task ID and their response.",
    });
  }
  return ok({ task_id: task.id, status: task.status, summary: task.summary, error: task.error_message, mutating: task.mutating, result });
}

// ─── Tool parameter schemas ─────────────────────────────────────

const obj = (properties: Json, required: string[] = []) => ({ type: "object", properties, required });
const S = (description: string) => ({ type: "string", description });
const B = (description: string) => ({ type: "boolean", description });
const N = (description: string) => ({ type: "number", description });

const HOSTNAME = S("Server hostname or display name");

/**
 * The fields get_agent_info returns, as the MCP tool does. The agent row also
 * carries the (masked) LLM API key, the LLM URL, enrollment details and the
 * emails of the users with access — none of which the model needs.
 */
const AGENT_INFO_FIELDS = [
  "id", "hostname", "display_name", "status", "node_type", "os_info", "agent_version",
  "ip_address", "ip_addresses", "is_public", "tags", "last_seen_at",
  "health_metrics", "llm_status",
];

/**
 * The agent info the model reads, shaped like the MCP tool's: group names, and
 * the EFFECTIVE read-only flag. The row's own `read_only_ai` misses an agent
 * made read-only through a group, and the model would plan changes it refuses.
 */
function agentInfo(row: Json = {}): Json {
  return {
    ...Object.fromEntries(AGENT_INFO_FIELDS.map(f => [f, row[f]])),
    groups: (row.groups ?? []).map((g: Json | string) => (typeof g === "string" ? g : g.name)),
    read_only_ai: row.read_only_ai_effective ?? row.read_only_ai,
  };
}

/** Skills a task can use: a direct assignment can be switched off, and run_task refuses those. */
const usableSkills = (skills: Json[] = []) => skills.filter(s => s.enabled !== false);
const GROUP = S("Filter by server group name");
const SITE = S("Filter by site name (datacenter, office, region)");
const AGENT = S("Filter by agent hostname or display name");
const SINCE = S('ISO-8601 date or datetime (inclusive), e.g. "2026-05-10"');
const UNTIL = S("ISO-8601 date or datetime (exclusive)");

/** Search tools → GET /api/search/<route>; the parameters are the filters. */
const SEARCHES: Array<{ name: string; route: string; description: string; parameters: Json }> = [
  {
    name: "search_agents", route: "agents",
    description: "List and filter servers by status, group, site, health metrics or free text. Call first to discover servers.",
    parameters: obj({
      query: S("Free text on hostname, OS, IP or tags"), status: S("online, offline, approved, pending_approval"),
      group: GROUP, site: SITE, cpu_above: N("CPU usage above %"), memory_above: N("Memory usage above %"), disk_above: N("Disk usage above %"),
    }),
  },
  {
    name: "search_inventory", route: "inventory",
    description: "Find which servers run a service, have a package installed or run containers, from stored inventory scans.",
    parameters: obj({
      query: S("Item name, version or details (e.g. nginx, docker)"),
      category: S("system, web, database, mail, container, network, storage, security, monitoring, log, user, scheduler, software, other"),
      status: S("running, stopped, installed, info"), group: GROUP, site: SITE,
    }),
  },
  {
    name: "search_security", route: "security",
    description: "Security issues across servers: audit findings, pentest findings and threat alerts, each tagged with its source.",
    parameters: obj({
      query: S("Search titles and explanations"), severity: S("Minimum severity: critical, high, medium, low"),
      category: S('ssh, firewall, users, permissions, updates, kernel, tls, docker, ... ("Threat Detection" for threats)'),
      source: S("audit, pentest, threat, or all"), unresolved: B("Only open items (default true)"),
      group: GROUP, site: SITE, since: SINCE, until: UNTIL,
    }),
  },
  {
    name: "search_activity", route: "activity",
    description: "User activity across servers: logins, failed logins, sudo commands and file changes, from stored activity scans.",
    parameters: obj({
      query: S("Username, command, source IP or file path"), category: S("sessions, failed_auth, root_commands, file_changes"),
      user: S("System username or ManageLM user"), group: GROUP, site: SITE, since: SINCE, until: UNTIL,
    }),
  },
  {
    name: "search_ssh_keys", route: "ssh-keys",
    description: 'SSH keys deployed on servers and registered in ManageLM profiles, with identity mapping. Use "user" for a person.',
    parameters: obj({
      query: S("Fingerprint or system username"), user: S('ManageLM user name or email ("me" for yourself)'),
      unknown_only: B("Only keys not matched to a ManageLM user"), group: GROUP, site: SITE,
    }),
  },
  {
    name: "search_sudo_rules", route: "sudo-rules",
    description: "Sudo rules (Linux) and administrator group membership (Windows) across servers.",
    parameters: obj({
      query: S("System username"), user: S('ManageLM user name or email ("me" for yourself)'),
      nopasswd_only: B("Only NOPASSWD rules"), group: GROUP, site: SITE,
    }),
  },
  {
    name: "search_certificates", route: "certs",
    description: "x509 certificates DISCOVERED on servers by certificate scans: expired, expiring, weak, self-signed, unmanaged.",
    parameters: obj({
      query: S("Subject, issuer or path"), status: S("managed, unmanaged, expired, expiring, weak, self_signed"),
      path: S("Filesystem path (partial)"), group: GROUP, site: SITE,
    }),
  },
  {
    name: "search_pki", route: "pki",
    description: "Certificates ManageLM itself issues and renews (Internal CA and Let's Encrypt).",
    parameters: obj({
      query: S("Common name, agent or SAN"), status: S("active, revoked, expired, failed, pending"),
      source: S("local_ca, letsencrypt"), agent: AGENT, site: SITE,
    }),
  },
  {
    name: "search_credentials", route: "credentials",
    description: "Credentials ManageLM rotates: last and next rotation, state, failures. Metadata only; values can never be retrieved. Requires the Credentials authorization.",
    parameters: obj({
      query: S("Name, account, host or connector"), state: S("active, failed, pending, rotating"),
      type: S("Kind or backend (substring): password, ssh_key, ldap, entra, ..."), agent: AGENT, site: SITE,
    }),
  },
  {
    name: "search_keystore", route: "keystore",
    description: "KSM Keystore: keys, the applications using them, and per-day usage or refusals. Metadata only. Requires the Keystore authorization.",
    parameters: obj({
      view: S("keys (default), clients, denied, activity"), query: S("Key, handle, application, caller or refusal reason"), agent: AGENT,
    }),
  },
  {
    name: "search_monitors", route: "monitors",
    description: "Monitors with their current status (up, down, degraded, pending, or stalled when the agent is offline), value and unit.",
    parameters: obj({
      query: S("Monitor name, agent or type"), status: S("up, down, degraded, pending, stalled"),
      slug: S("Monitor type: website, mysql, smtp, cpu, memory, filesystem, process, ..."), agent: AGENT, site: SITE,
    }),
  },
  {
    name: "search_backups", route: "backups",
    description: "Filesystem backups with status, schedule, snapshot count and last run.",
    parameters: obj({ query: S("Backup name, source path or agent"), status: S("pending, running, ok, failed"), agent: AGENT, site: SITE }),
  },
  {
    name: "list_connectors", route: "connectors",
    description: "Hosting connectors (AWS, Azure, GCP, OpenStack, Proxmox, VMware) with sync status and resource counts.",
    parameters: obj({}),
  },
  {
    name: "search_cloud", route: "cloud",
    description: "VMs, volumes, networks and security groups discovered by hosting connectors.",
    parameters: obj({
      query: S("Resource name, provider ID or region"), type: S("vm, volume, network, security_group"),
      status: S("Provider-side status (running, stopped, ...)"), provider: S("aws, azure, gcp, vmware, proxmox, openstack"),
      connector: S("Connector name"), unmatched: B("Only VMs with no ManageLM agent"),
    }),
  },
];

/** run_* scan tools → scan type. */
const SCAN_TOOLS: Array<{ name: string; type: string; what: string }> = [
  { name: "run_security_audit", type: "security", what: "a security audit (SSH, firewall, ports, users, TLS, kernel, ...)" },
  { name: "run_inventory_scan", type: "inventory", what: "an inventory scan (services, packages, containers, network, storage)" },
  { name: "run_access_scan", type: "access", what: "an access scan (SSH authorized keys and sudo rules, or Windows local accounts)" },
  { name: "run_certificate_scan", type: "certificates", what: "a certificate discovery scan (metadata only, never private keys)" },
  { name: "run_activity_scan", type: "activity", what: "an activity scan over the last 24 hours (logins, failed logins, sudo, file changes)" },
];

// ─── Webhook events ─────────────────────────────────────────────

/** Titles for every event the portal delivers; unknown events are logged by name. */
const EVENT_TITLES: Record<string, string> = {
  "agent.enrolled": "New server awaiting approval", "agent.approved": "Server approved",
  "agent.online": "Server online", "agent.offline": "Server offline",
  "task.completed": "Task completed", "task.failed": "Task failed", "task.needs_input": "Task needs input",
  "report.completed": "Report completed", "report.failed": "Report failed", "report.stalled": "Report stalled",
  "monitor.down": "Monitor down", "monitor.up": "Monitor up", "monitor.stalled": "Monitoring stopped",
  "monitor.created": "Monitor created", "monitor.deleted": "Monitor deleted",
  "backup.completed": "Backup completed", "backup.failed": "Backup failed",
  "cert.issued": "Certificate issued", "cert.renewed": "Certificate renewed", "cert.renewal_failed": "Certificate renewal failed",
  "cert.revoked": "Certificate revoked", "cert.reactivated": "Certificate reactivated", "cert.deleted": "Certificate deleted",
  "credential.rotated": "Credential rotated", "credential.rotation_failed": "Credential rotation failed",
  "keystore.access_denied": "Keystore access denied", "keystore.key_deleted": "Keystore key deleted",
  "pentest.completed": "Pentest completed", "pentest.failed": "Pentest failed",
  "console.opened": "Console opened", "console.closed": "Console closed",
  "desktop.opened": "Desktop session opened", "desktop.closed": "Desktop session closed",
  "files.opened": "File browser opened",
  "schedule.report": "Scheduled task reported", "schedule.failed": "Scheduled task failed",
};

/** Deliveries are small JSON documents; refuse anything larger unread. */
const MAX_WEBHOOK_BODY = 512 * 1024;

/** One log line for a delivery: title, host, and the most telling detail. */
function describeEvent(evt: Json): string {
  const d: Json = evt.data || {};
  const title = EVENT_TITLES[evt.event] || evt.event;
  const host = d.display_name || d.hostname || d.agent_name;
  const who = d.user_email && `by ${d.user_email}`;
  const subject = d.monitor_name || d.backup_name || d.schedule_name || d.common_name || d.credential_name || d.handle
    || (d.report_type && `${String(d.report_type).replace(/_/g, " ")} report`);
  const detail = d.question || d.error_message || d.error || d.summary || d.reason;
  const line = [title, host && `on ${host}`, subject && `(${subject})`, who].filter(Boolean).join(" ");
  return detail ? `${line}: ${detail}` : line;
}

// ─── Plugin ─────────────────────────────────────────────────────

export default definePluginEntry({
  id: "managelm",
  name: "ManageLM",
  description: "Manage Linux & Windows servers with natural language",

  register(api: PluginApi) {
    const portal = createApi(api);

    /** Register a tool as managelm_<name>. */
    const tool = (name: string, description: string, parameters: Json, run: (p: Json) => Promise<any>) =>
      api.registerTool({
        name: `managelm_${name}`, description, parameters,
        async execute(_id: string, p: any) { return run(p || {}); },
      });

    /** Resolve p.hostname to exactly one agent, or return the error result for the model. */
    const withAgent = async (p: Json, run: (agent: Agent) => Promise<any>) => {
      if (!p.hostname) return err("hostname is required");
      const found = await portal.findAgent(String(p.hostname));
      return "agent" in found ? run(found.agent) : err(found.error);
    };

    /** The error result when a required string parameter is missing, else null. */
    const missing = (p: Json, ...names: string[]) => {
      const absent = names.filter(n => typeof p[n] !== "string" || !p[n]);
      return absent.length ? err(`${absent.join(", ")} ${absent.length > 1 ? "are" : "is"} required`) : null;
    };

    // ── Discovery ───────────────────────────────────────────────

    tool("get_agent_info", "Detailed info for one server: OS, version, IPs, health, status, assigned skills and recent tasks.",
      obj({ hostname: HOSTNAME }, ["hostname"]),
      p => withAgent(p, async agent => {
        const [full, skills, tasks] = await Promise.all([
          portal.get(`/agents/${agent.id}`),
          portal.get(`/agents/${agent.id}/skills`).catch(() => ({ skills: [] })),   // No LLM accounts have no skills route
          portal.get("/tasks", { agent_id: agent.id, limit: 5 }),
        ]);
        return ok({
          agent: agentInfo(full.agent),
          skills: usableSkills(skills.skills).map((s: Json) => ({ slug: s.slug, name: s.name })),
          recent_tasks: (tasks.tasks || []).map((t: Json) => ({ id: t.id, skill: t.skill_slug, status: t.status, summary: t.summary, created_at: t.created_at })),
        });
      }));

    tool("get_agent_skills", "Skills assigned to a server (directly or through a group). Use it to pick the skill for managelm_run_task.",
      obj({ hostname: HOSTNAME }, ["hostname"]),
      p => withAgent(p, async agent => {
        const { skills = [] } = await portal.get(`/agents/${agent.id}/skills`);
        return ok({ hostname: agent.hostname, skills: usableSkills(skills).map((s: Json) => ({ slug: s.slug, name: s.name, description: s.description })) });
      }));

    tool("list_available_skills", "Catalog skills not yet imported into the account.", obj({}), async () => {
      const { catalog = [] } = await portal.get("/skills/catalog");
      return ok({ available: catalog.filter((s: Json) => !s.imported).map((s: Json) => ({ slug: s.slug, name: s.name, node_type: s.node_type, description: s.description })) });
    });

    tool("get_account_info", "Account name, optional features, and the groups and sites (valid group / site filter values).", obj({}), async () => {
      const [account, groups, sites] = await Promise.all([portal.get("/account"), portal.get("/groups"), portal.get("/sites")]);
      return ok({
        account: account.account, members: (account.users || []).length,
        groups: (groups.groups || []).map((g: Json) => g.name), sites: (sites.sites || []).map((s: Json) => s.name),
      });
    });

    tool("list_team_members", "ManageLM users with their role, permissions and whether they registered an SSH key.",
      obj({ user: S("Filter by name or email (partial match)") }),
      async p => {
        const { users = [] } = await portal.get("/account");
        const filter = String(p.user || "").toLowerCase();
        return ok({
          members: users
            .filter((u: Json) => !filter || `${u.first_name} ${u.last_name} ${u.email}`.toLowerCase().includes(filter))
            .map((u: Json) => ({
              name: `${u.first_name || ""} ${u.last_name || ""}`.trim(), email: u.email, role: u.account_role,
              enabled: u.enabled, has_ssh_key: u.has_ssh_key, system_username: u.system_username,
              permissions: Object.keys(u).filter(k => k.startsWith("perm_") && u[k]).map(k => k.slice(5)),
            })),
        });
      });

    // ── Search (read-only, queries stored data) ─────────────────

    for (const s of SEARCHES) {
      tool(s.name, s.description, s.parameters, async p => ok(await portal.get(`/search/${s.route}`, p)));
    }

    // ── Hosting ─────────────────────────────────────────────────

    tool("get_cloud_info", "One hosting resource by name or provider ID, with the actions its connector allows and their risk.",
      obj({ resource: S("Resource name or provider ID") }, ["resource"]),
      async p => {
        if (!p.resource) return err("resource is required");
        const { resources = [] } = await portal.get("/search/cloud", { query: p.resource });
        if (!resources.length) return err(`No hosting resource matches "${p.resource}". Use managelm_search_cloud to browse.`);
        const matches: Json[] = resources.slice(0, 5);
        const actions = new Map<string, Json>();
        for (const r of matches) {
          if (!actions.has(r.connector_id)) actions.set(r.connector_id, await portal.get(`/connectors/${r.connector_id}/actions`));
        }
        const rows = matches.map(r => ({ ...r, available_actions: actions.get(r.connector_id)?.actions ?? [] }));
        return ok(rows.length === 1 ? rows[0] : rows);
      });

    tool("cloud_action",
      "Start, shut down, stop, reboot or snapshot a VM through its hosting connector. The resource must match exactly one VM. Disruptive actions need confirm=true: ask the user first. Requires the Hosting authorization.",
      obj({
        resource: S("VM name or provider ID"),
        action: S("Action ID from managelm_get_cloud_info, e.g. vm.start, vm.shutdown, vm.reboot, vm.snapshot.create"),
        params: { type: "object", description: 'Action parameters, e.g. {"name": "before-upgrade"} for a snapshot' },
        confirm: B("Required (true) for disruptive actions. Never set it without asking the user."),
      }, ["resource", "action"]),
      async p => {
        const absent = missing(p, "resource", "action");
        if (absent) return absent;
        // Exactly one VM, by exact name or provider ID, as the MCP tool requires.
        // The search also matches regions and partial names, which only ever
        // become suggestions: never guess which machine to act on.
        const { resources = [], truncated } = await portal.get("/search/cloud", { query: p.resource, type: "vm" });
        const lower = String(p.resource).toLowerCase();
        const exact: Json[] = resources.filter((r: Json) => String(r.name).toLowerCase() === lower || String(r.provider_id).toLowerCase() === lower);
        const listed = (rows: Json[]) => rows.slice(0, 10).map(r => ({ name: r.name, provider_id: r.provider_id, connector: r.connector_name }));
        if (exact.length === 0 && truncated) {
          // The search stops at 100 rows ordered by name: an exactly named VM
          // can be past the cap, so this is not "no such VM".
          return err(`Too many VMs match "${p.resource}" to find it by name. Ask the user for its exact provider ID.`);
        }
        if (exact.length === 0) {
          return resources.length === 0
            ? err(`No VM matches "${p.resource}". Use managelm_search_cloud to find it.`)
            : ok({ error: `No VM is named "${p.resource}". Ask the user which one they mean; do not choose on their behalf.`, candidates: listed(resources) });
        }
        if (exact.length > 1) {
          return ok({ error: `"${p.resource}" names ${exact.length} VMs. Ask the user which one; do not choose on their behalf.`, candidates: listed(exact) });
        }
        const vm = exact[0];
        const { actions = [] } = await portal.get(`/connectors/${vm.connector_id}/actions`);
        const descriptor = actions.find((a: Json) => a.id === p.action);
        if (!descriptor) return ok({ error: `Action "${p.action}" is not allowed on ${vm.name}.`, allowed_actions: actions.map((a: Json) => a.id) });
        if (descriptor.risk === "disruptive" && p.confirm !== true) {
          return err(`"${p.action}" on ${vm.name} (${vm.connector_name}) is disruptive: ${descriptor.description} Ask the user to confirm this VM and action, then retry with confirm=true.`);
        }
        return ok(await portal.post(`/connectors/${vm.connector_id}/actions`, { resource_id: vm.id, action: p.action, params: p.params }, SLOW_CALL_TIMEOUT_MS));
      });

    // ── Scans (start + wait) ────────────────────────────────────

    for (const s of SCAN_TOOLS) {
      tool(s.name, `Run ${s.what} on one server and wait for the result (up to 3 minutes). Requires the Reports authorization on the API key.`,
        obj({ hostname: HOSTNAME }, ["hostname"]),
        p => withAgent(p, async agent => {
          const scan = await portal.runScanAndWait(s.type, agent.id);
          if (!scan) return err("The scan did not produce a result.");
          if (scan.status === "running" || scan.status === "pending") {
            return ok({ hostname: agent.hostname, status: "running", message: "The scan is still running. Its result will be in the matching managelm_search_* tool once it completes." });
          }
          if (scan.status === "failed") return ok({ hostname: agent.hostname, status: "failed", error: scan.error_message });
          return ok({ hostname: agent.hostname, status: scan.status, completed_at: scan.completed_at, report: scan.report });
        }));
    }

    // ── Tasks ───────────────────────────────────────────────────

    tool("run_task",
      'Run a natural-language task on one server with a skill. Use managelm_get_agent_skills to choose the skill, or "auto" to let the agent pick. Waits up to 2 minutes; a longer task returns status "running" with its task_id.',
      obj({
        hostname: HOSTNAME,
        skill: S('Skill slug (e.g. packages, services, users, containers, webserver, database) or "auto"'),
        instruction: S("What to do, in plain language. Be specific."),
      }, ["hostname", "skill", "instruction"]),
      p => withAgent(p, async agent => {
        const absent = missing(p, "skill", "instruction");
        if (absent) return absent;
        if (agent.status !== "online") return err(`Server "${agent.hostname}" is ${agent.status}`);
        return taskOutcome(await portal.postTask("/tasks", { agent_id: agent.id, skill_slug: p.skill, instruction: p.instruction }));
      }));

    tool("answer_task", "Answer the question of a task in needs_input status (the agent needs a domain name, password, choice, ...). Ask the user first.",
      obj({ task_id: S("Task ID in needs_input status"), answer: S("The user's answer") }, ["task_id", "answer"]),
      async p => missing(p, "task_id", "answer")
        ?? taskOutcome(await portal.postTask(`/tasks/${encodeURIComponent(p.task_id)}/answer`, { answer: p.answer })));

    tool("follow_up_task", "Continue the conversation of a completed task (context kept for 5 minutes).",
      obj({ task_id: S("ID of the completed task"), instruction: S("Follow-up request") }, ["task_id", "instruction"]),
      async p => missing(p, "task_id", "instruction")
        ?? taskOutcome(await portal.postTask(`/tasks/${encodeURIComponent(p.task_id)}/follow-up`, { instruction: p.instruction })));

    tool("get_task_status", "Status and result of a task by ID.",
      obj({ task_id: S("Task ID") }, ["task_id"]),
      async p => missing(p, "task_id") ?? ok(await portal.get(`/tasks/${encodeURIComponent(p.task_id)}`)));

    tool("get_task_history", "Recent tasks on a server, optionally within a time range.",
      obj({ hostname: HOSTNAME, limit: N("Max results (default 20, max 200)"), since: SINCE, until: UNTIL }, ["hostname"]),
      p => withAgent(p, async agent => {
        const limit = typeof p.limit === "number" ? Math.min(p.limit, 200) : 20;
        const { tasks = [] } = await portal.get("/tasks", { agent_id: agent.id, limit, since: p.since, until: p.until });
        return ok({
          hostname: agent.hostname,
          tasks: tasks.map((t: Json) => ({ id: t.id, skill: t.skill_slug, status: t.status, summary: t.summary, question: t.question, created_at: t.created_at })),
        });
      }));

    tool("get_task_changes", "Files changed by a task, with an optional full diff fetched from the agent.",
      obj({ task_id: S("Task ID"), full_diff: B("Fetch the unified diff (agent must be online)") }, ["task_id"]),
      async p => missing(p, "task_id") ?? ok((p.full_diff === true
        ? await portal.get(`/tasks/${encodeURIComponent(p.task_id)}/changes`, { full_diff: "true" }, SLOW_CALL_TIMEOUT_MS)
        : await portal.get(`/tasks/${encodeURIComponent(p.task_id)}/changes`)).changeset));

    tool("revert_task", "Revert the file changes of a task (agent online, changes under 30 days old). Call managelm_get_task_changes first.",
      obj({ task_id: S("Task ID to revert") }, ["task_id"]),
      async p => missing(p, "task_id") ?? ok(await portal.post(`/tasks/${encodeURIComponent(p.task_id)}/revert`, {}, SLOW_CALL_TIMEOUT_MS)));

    // ── Utility ─────────────────────────────────────────────────

    tool("send_email", "Send yourself an email with a report or summary (plain text).",
      obj({ subject: S("Email subject"), body: S("Plain-text body; blank lines separate paragraphs") }, ["subject", "body"]),
      async p => missing(p, "subject", "body") ?? ok(await portal.post("/email", { subject: p.subject, body: p.body })));

    // ── Webhook ─────────────────────────────────────────────────

    api.registerHttpRoute({
      path: "/managelm/webhook",
      auth: "plugin",
      match: "exact",
      handler: async (req: any, res: any) => {
        const pc = api.pluginConfig as PluginConfig;
        const secret = pc.webhookSecret || (api.config?.plugins?.entries?.managelm?.config as any)?.webhookSecret;
        // Refuse rather than accept silently: a failed delivery shows up on the
        // portal's webhook, a swallowed one looks like it worked.
        if (!secret) { res.statusCode = 503; res.end("Webhook secret not configured"); return true; }

        let raw = "";
        if (typeof req.body === "string") raw = req.body;
        else if (req.body && typeof req.body === "object") raw = JSON.stringify(req.body);
        else {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of req) {
            size += c.length;
            if (size > MAX_WEBHOOK_BODY) { res.statusCode = 413; res.end("Payload too large"); return true; }
            chunks.push(c);
          }
          raw = Buffer.concat(chunks).toString("utf8");
        }

        // Portal signs deliveries with X-Webhook-Signature (HMAC-SHA256 hex of
        // the raw body) — see portal/src/webhooks/routes.ts deliverWebhook().
        const sig = req.headers["x-webhook-signature"];
        // Compare bytes, not string lengths: a same-length header with a
        // multi-byte character would make timingSafeEqual throw.
        const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
        const given = Buffer.from(typeof sig === "string" ? sig : "");
        if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) {
          res.statusCode = 401; res.end("Bad signature"); return true;
        }

        let evt: Json;
        try { evt = JSON.parse(raw); }
        catch { res.statusCode = 400; res.end("Invalid JSON"); return true; }

        // The signed body carries its send time; the portal retries the same
        // body within ~15 s, so anything outside the window is a replay.
        const sentAt = Date.parse(evt.timestamp);
        if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > WEBHOOK_MAX_AGE_MS) {
          res.statusCode = 401; res.end("Stale delivery"); return true;
        }
        if (isReplay(sig as string, Date.now())) {
          res.statusCode = 200; res.end("duplicate"); return true;
        }

        // Deliveries are { event, timestamp, data } — the details live in data.
        api.logger.info(`[ManageLM] ${describeEvent(evt)}`);

        res.statusCode = 200; res.end("ok"); return true;
      },
    });
  },
});
