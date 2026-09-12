/**
 * dsh 周边 → CodeBuddy CLI 的原生接入(同步器)。
 *
 * - **MCP**:把 dsh 的 mcp-client 配置(profile 的 cordis 配置行)同步进
 *   `~/.codebuddy/mcp.json`——CLI 用**自己的 MCP 系统**连接服务器,工具以
 *   原生形态出现,而不是走委托工具桥往返;
 * - **Skill**:把 dsh 的 skills(`~/.dsh/skills/<name>/SKILL.md`)以目录联接
 *   接入 CLI 的用户 skill 目录(`~/.codebuddy/skills/`,格式同源),CLI 原生加载。
 *
 * 两者都幂等:每次 CodeBuddy 进程启动前(回合建立时)与插件装载时各同步一次,
 * 保证 CLI 读到最新配置;失败绝不打断对话(只记日志)。用户手配的 mcp.json
 * 其他条目/其他 skill 目录保持不动,同名时以 dsh 侧为准。
 * @module subagent-codebuddy/cli-integrations
 */
/** 同步结果(供日志)。 */
export interface IntegrationSyncResult {
    /** 本次写入 CodeBuddy 的 MCP server 名与目标文件。 */
    mcp: {
        servers: string[];
        targetFile: string;
    };
    /** 本次新接入的 skill 名与目标目录。 */
    skills: {
        linked: string[];
        targetDir: string;
    };
}
/** 一行 mcp-client 配置(dsh 侧;键值都是标量或标量数组)。 */
interface McpRow {
    serverName: string;
    config: Record<string, string | string[]>;
}
/**
 * 从 dsh profile 的 cordis 配置文本里收集 mcp-client 行。
 * 只认 `name: '@deepseek-ai/dsh-mcp-client'` 的行块,读取其 `config:` 下的标量键。
 * @param text - 一份 cordis.yml / cordis.patch.yml 的文本。
 * @returns 解析出的 server 行(serverName 缺失或无效的行丢弃)。
 */
export declare function parseMcpClientRows(text: string): McpRow[];
/**
 * 同步 dsh 的 MCP server 配置进 CodeBuddy 的 mcp.json(合并保留其他条目)。
 * @param profilesRoot - dsh profiles 根(默认 `~/.dsh/profiles`)。
 * @param targetFile - CodeBuddy 的 mcp.json(默认 `~/.codebuddy/mcp.json`)。
 * @returns 本次写入的 server 名(按去重后的解析顺序)。
 */
export declare function syncMcpToCodebuddy(profilesRoot?: string, targetFile?: string): {
    servers: string[];
    targetFile: string;
};
/**
 * 把 dsh 的全部 skill 根以目录联接接入 CodeBuddy 的用户 skill 目录(幂等)。
 *
 * 覆盖 dsh-skill-filesystem 的默认根(rank 顺序,同名高优先赢,与 dsh 的
 * "winning skill per name" 合并语义一致):
 * | rank | 来源 | 路径 |
 * | 100 | project-dsh | `<projectRoot>/.dsh/skills` |
 * | 200 | project-agents | `<projectRoot>/.agents/skills` |
 * | 400 | user-dsh | `<dshHome>/skills` |
 * | 500 | user-agents | `<agentsHome>/skills` |
 * (custom/bundled 根由部署配置引入,插件侧不可枚举,不在本次接入范围。)
 *
 * 目标已存在(用户手放的同名 skill)时跳过,不覆盖。
 * @param options - 各根的路径覆盖(测试用;projectCwd 决定项目根)。
 * @returns 本次新接入的 skill 名。
 */
export declare function syncSkillsToCodebuddy(options?: SkillSyncOptions): {
    linked: string[];
    targetDir: string;
};
/** skill 同步的路径选项。 */
export interface SkillSyncOptions {
    /** 会话工作目录(dsh 的项目根 = 最近含 .git 的祖先;无则用它自身)。 */
    projectCwd?: string;
    /** 用户 dsh 根(默认 `$DSH_HOME` 或 `~/.dsh`)。 */
    dshHome?: string;
    /** 共享 agents 根(默认 `$DSH_AGENTS_HOME` 或 `~/.agents`)。 */
    agentsHome?: string;
    /** CodeBuddy skills 根(默认 `~/.codebuddy/skills`)。 */
    targetDir?: string;
}
/** 同步可覆盖的路径(测试用;默认取真实 home 布局)。 */
export interface CliIntegrationPaths {
    profilesRoot?: string;
    mcpFile?: string;
    /** 会话工作目录:项目级 skill 根(`<projectRoot>/.dsh/skills` 等)的定位依据。 */
    projectCwd?: string;
    dshHome?: string;
    agentsHome?: string;
    skillsTargetDir?: string;
}
/**
 * 一次同步 MCP 与 Skill(CodeBuddy CLI 进程启动前调用保证最新)。
 * 全程容错:任一步失败只影响该项,调用方无需 try/catch。
 * @param paths - 路径覆盖(测试用)。
 * @returns 各项同步结果。
 */
export declare function syncCliIntegrations(paths?: CliIntegrationPaths): IntegrationSyncResult;
export {};
