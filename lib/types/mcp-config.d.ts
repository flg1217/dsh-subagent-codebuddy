/**
 * CodeBuddy 方言:MCP 通道的 `--mcp-config` 文件管理。
 *
 * 通用部分(端点注册、key、工具面、执行、图片回传)在共享包
 * `@flg1217/dsh-mcp`;这里只保留 CodeBuddy CLI 特有的落盘形态——CLI 的
 * `--mcp-config <file>` 需要一份会话专属 JSON(URL 含 session/key,供端侧
 * 解析 per-agent 工具集),以及配套的目录约定与陈旧文件清扫。
 *
 * @module subagent-codebuddy/mcp-config
 */
/**
 * 清扫陈旧 `--mcp-config` 文件(插件启动时一次,尽力而为)。
 *
 * 文件按"会话+内容摘要"命名:每进程新 key、端口变化、测试套件运行都会生成
 * 新文件,只增不删会持续堆积;且文件内含端点 key,同用户任意进程可读。阈值
 * 取 1 小时:任何可能仍被在启 CLI 读取的配置都远新于此,多实例/多进程共享
 * 同一 temp 目录时也不会误删在用的文件。
 * @param dir - 目标目录(默认 {@link mcpConfigDir};测试可注入)。
 * @param maxAgeMs - 超过该年龄(毫秒)的文件删除,默认 1 小时。
 * @returns 实际删除的文件数(测试用)。
 */
export declare function sweepStaleMcpConfigs(dir?: string, maxAgeMs?: number): number;
/**
 * 生成会话专属的 `--mcp-config` 文件并返回其路径。
 * @param dshSessionId - 会话 id(URL 携带,端侧据此解析 per-agent 工具集)。
 * @returns 配置文件路径;端点未就绪时 undefined(调用方跳过该参数)。
 */
export declare function writeDshMcpConfigFile(dshSessionId: string): string | undefined;
/**
 * spawn 参数:bridgeMode **显式等于 `mcp`** 时生成会话专属 MCP 配置并返回
 * `--mcp-config` 参数。
 * @param bridgeMode - 桥接模式(undefined 与 delegate 同义:不注入)。
 * @param dshSessionId - 会话 id(MCP URL 携带,端侧据此解析 per-agent 工具集)。
 * @returns 追加到 CLI argv 的参数(空数组表示不启用 MCP 通道)。
 */
export declare function mcpConfigArgs(bridgeMode: 'mcp' | 'delegate' | undefined, dshSessionId: string | undefined): string[];
