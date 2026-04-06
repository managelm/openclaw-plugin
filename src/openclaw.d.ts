/**
 * Type declarations for OpenClaw Plugin SDK.
 * Based on https://docs.openclaw.ai/plugins/building-plugins.md
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  interface PluginLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
  }

  interface PluginApi {
    id: string;
    config: Record<string, any>;
    pluginConfig: Record<string, unknown>;
    logger: PluginLogger;
    runtime: Record<string, any>;

    registerTool(tool: {
      name: string;
      description: string;
      parameters: Record<string, any>;
      execute(_id: string, params: any): Promise<{ content: { type: string; text: string }[] }>;
    }, opts?: { optional?: boolean }): void;

    registerCommand(def: { name: string; description: string; handler: (...args: any[]) => any }): void;

    registerHttpRoute(params: {
      path: string;
      auth: "gateway" | "plugin";
      match?: "exact" | "prefix";
      handler: (req: any, res: any) => Promise<boolean> | boolean;
    }): void;
  }

  interface PluginEntryDef {
    id: string;
    name: string;
    description: string;
    register(api: PluginApi): void;
  }

  export { PluginApi, PluginEntryDef };
  export function definePluginEntry(def: PluginEntryDef): PluginEntryDef;
}
