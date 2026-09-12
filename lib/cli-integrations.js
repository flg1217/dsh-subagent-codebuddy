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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
/** 去掉 YAML 标量的引号。 */
function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '\'' && last === '\'') || (first === '"' && last === '"')) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}
/** 解析 YAML 行值:标量、内联数组(`[a, 'b c']`)或空。 */
function parseYamlValue(raw) {
    const value = raw.trim();
    if (value.length === 0)
        return undefined;
    if (value.startsWith('[') && value.endsWith(']')) {
        return value
            .slice(1, -1)
            .split(',')
            .map(item => unquote(item))
            .filter(item => item.length > 0);
    }
    return unquote(value);
}
/**
 * 从 dsh profile 的 cordis 配置文本里收集 mcp-client 行。
 * 只认 `name: '@deepseek-ai/dsh-mcp-client'` 的行块,读取其 `config:` 下的标量键。
 * @param text - 一份 cordis.yml / cordis.patch.yml 的文本。
 * @returns 解析出的 server 行(serverName 缺失或无效的行丢弃)。
 */
export function parseMcpClientRows(text) {
    const rows = [];
    let current;
    let inConfig = false;
    let configIndent = 0;
    const flush = () => {
        if (current?.isMcpClient === true) {
            const serverName = current.config['serverName'];
            if (typeof serverName === 'string' && serverName.length > 0) {
                rows.push({ serverName, config: current.config });
            }
        }
        current = undefined;
        inConfig = false;
    };
    for (const line of text.split(/\r?\n/)) {
        const indent = line.length - line.trimStart().length;
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#'))
            continue;
        // 新的列表项(`- id: ...`)开启一个块。
        if (trimmed.startsWith('- ')) {
            flush();
            current = { isMcpClient: false, config: {} };
            continue;
        }
        if (current === undefined)
            continue;
        if (inConfig && indent > configIndent) {
            const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(trimmed);
            if (match !== null) {
                const value = parseYamlValue(match[2]);
                if (value !== undefined)
                    current.config[match[1]] = value;
            }
            continue;
        }
        // 块级键(name / config)。
        inConfig = false;
        const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(trimmed);
        if (match === null)
            continue;
        const key = match[1];
        if (key === 'name') {
            const value = parseYamlValue(match[2]);
            current.isMcpClient = value === '@deepseek-ai/dsh-mcp-client';
        }
        else if (key === 'config' && current.isMcpClient) {
            inConfig = true;
            configIndent = indent;
        }
    }
    flush();
    return rows;
}
/** dsh 的 mcp-client 配置行 → CodeBuddy mcp.json 的 server 条目;无法映射时 undefined。 */
function toCliMcpServer(row) {
    const transport = typeof row.config['transport'] === 'string' ? row.config['transport'] : 'stdio';
    if (transport === 'stdio') {
        const command = row.config['command'];
        if (typeof command !== 'string' || command.length === 0)
            return undefined;
        const args = row.config['args'];
        return {
            type: 'stdio',
            command,
            args: Array.isArray(args) ? args : [],
        };
    }
    const url = row.config['url'];
    if (typeof url !== 'string' || url.length === 0)
        return undefined;
    return {
        type: transport === 'streamable-http' ? 'http' : transport,
        url,
    };
}
/** 收集全部 profile 目录下的 cordis 配置文本。 */
function readProfileConfigs(profilesRoot) {
    const texts = [];
    let entries;
    try {
        entries = readdirSync(profilesRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    }
    catch {
        return texts;
    }
    for (const profile of entries) {
        for (const file of ['cordis.patch.yml', 'cordis.yml']) {
            try {
                texts.push(readFileSync(join(profilesRoot, profile, file), 'utf8'));
            }
            catch { /* 缺失跳过 */ }
        }
    }
    return texts;
}
/**
 * 同步 dsh 的 MCP server 配置进 CodeBuddy 的 mcp.json(合并保留其他条目)。
 * @param profilesRoot - dsh profiles 根(默认 `~/.dsh/profiles`)。
 * @param targetFile - CodeBuddy 的 mcp.json(默认 `~/.codebuddy/mcp.json`)。
 * @returns 本次写入的 server 名(按去重后的解析顺序)。
 */
export function syncMcpToCodebuddy(profilesRoot, targetFile) {
    const root = profilesRoot ?? join(homedir(), '.dsh', 'profiles');
    const target = targetFile ?? join(homedir(), '.codebuddy', 'mcp.json');
    const servers = {};
    for (const text of readProfileConfigs(root)) {
        for (const row of parseMcpClientRows(text)) {
            const server = toCliMcpServer(row);
            if (server !== undefined)
                servers[row.serverName] = server;
        }
    }
    const names = Object.keys(servers);
    if (names.length === 0)
        return { servers: [], targetFile: target };
    let doc = {};
    try {
        const parsed = JSON.parse(readFileSync(target, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            doc = parsed;
        }
    }
    catch { /* 不存在或损坏:重建 */ }
    const existing = doc['mcpServers'];
    const mcpServers = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : {};
    let changed = false;
    for (const [name, server] of Object.entries(servers)) {
        if (JSON.stringify(mcpServers[name]) !== JSON.stringify(server)) {
            mcpServers[name] = server;
            changed = true;
        }
    }
    doc['mcpServers'] = mcpServers;
    if (changed) {
        mkdirSync(dirname(target), { recursive: true });
        const tmp = `${target}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
        renameSync(tmp, target);
    }
    return { servers: names, targetFile: target };
}
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
export function syncSkillsToCodebuddy(options) {
    const target = options?.targetDir ?? join(homedir(), '.codebuddy', 'skills');
    const linked = [];
    // dsh 的同名合并语义:高 rank 根先占名,低 rank 不重复接入(无论其接入成败)。
    const claimed = new Set();
    for (const root of skillRoots(options ?? {})) {
        let entries;
        try {
            entries = readdirSync(root, { withFileTypes: true })
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name);
        }
        catch {
            continue;
        }
        for (const name of entries) {
            if (claimed.has(name))
                continue;
            const from = join(root, name);
            if (!existsSync(join(from, 'SKILL.md')))
                continue;
            claimed.add(name);
            const to = join(target, name);
            if (existsSync(to))
                continue;
            try {
                mkdirSync(target, { recursive: true });
                symlinkSync(from, to, 'junction');
                linked.push(name);
            }
            catch { /* 链接失败:跳过该项目 */ }
        }
    }
    return { linked, targetDir: target };
}
/** 会话工作目录 → 项目根(最近含 `.git` 的祖先;没有则取自身)。 */
function projectRootOf(cwd) {
    let current = resolve(cwd);
    for (;;) {
        if (existsSync(join(current, '.git')))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return resolve(cwd);
        current = parent;
    }
}
/** 按 rank 顺序列出要扫描的 skill 根。 */
function skillRoots(options) {
    const dshHome = options.dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
    const agentsHome = options.agentsHome ?? process.env['DSH_AGENTS_HOME'] ?? join(homedir(), '.agents');
    const roots = [];
    if (options.projectCwd !== undefined && options.projectCwd.length > 0) {
        const project = projectRootOf(options.projectCwd);
        roots.push(join(project, '.dsh', 'skills'));
        roots.push(join(project, '.agents', 'skills'));
    }
    roots.push(join(dshHome, 'skills'));
    roots.push(join(agentsHome, 'skills'));
    return roots;
}
/**
 * 一次同步 MCP 与 Skill(CodeBuddy CLI 进程启动前调用保证最新)。
 * 全程容错:任一步失败只影响该项,调用方无需 try/catch。
 * @param paths - 路径覆盖(测试用)。
 * @returns 各项同步结果。
 */
export function syncCliIntegrations(paths) {
    let mcp = { servers: [], targetFile: '' };
    let skills = { linked: [], targetDir: '' };
    try {
        mcp = syncMcpToCodebuddy(paths?.profilesRoot, paths?.mcpFile);
    }
    catch { /* MCP 同步失败不打断 */ }
    try {
        skills = syncSkillsToCodebuddy({
            ...(paths?.projectCwd === undefined ? {} : { projectCwd: paths.projectCwd }),
            ...(paths?.dshHome === undefined ? {} : { dshHome: paths.dshHome }),
            ...(paths?.agentsHome === undefined ? {} : { agentsHome: paths.agentsHome }),
            ...(paths?.skillsTargetDir === undefined ? {} : { targetDir: paths.skillsTargetDir }),
        });
    }
    catch { /* Skill 同步失败不打断 */ }
    return { mcp, skills };
}
