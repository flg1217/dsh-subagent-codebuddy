/**
 * CodeBuddy 模型能力(图片输入)解析。
 *
 * 真相来源:CLI 自己的配置 `models.json`(`<configDir>/models.json`,条目含
 * `id` 与 `supportsImages`)。dsh 侧需要它做两件事:
 * - `resolveModel()` 声明真实的 `inputModalities`(仅文本模型才不会收到图片块);
 * - 提示词/工具目录按模态分流(多模态 → 原生 read_image;仅文本 → read_image_agy)。
 *
 * **未知一律按仅文本**(用户决策):只有 `supportsImages === true` 的登记条目算
 * 多模态;未登记、文件缺失、解析失败、字段缺失/异常类型都按仅文本——宁可让
 * 多模态模型退化为 AGY 转述,也不把图片块送给只吃文本的上游。
 *
 * 本模块**只读本地 JSON,绝不 spawn CLI、绝不抛错**;读不到就是空表。
 * @module subagent-codebuddy/model-capabilities
 */
/** 模型 id 的别名前缀:CLI 用它们引用自定义模型(`custom-local:<id>` / `custom:<id>`)。 */
export declare const CUSTOM_LOCAL_PREFIX = "custom-local:";
/** 另一条自定义模型前缀(见 CLI 产物的 `CUSTOM_MODEL_ID_PREFIX`)。 */
export declare const CUSTOM_PREFIX = "custom:";
/** 一个模型 id 的图片输入能力。 */
export interface ModelImageCapability {
    /** 是否原生支持图片输入(未登记/字段缺失/异常类型一律 false)。 */
    readonly supportsImages: boolean;
    /** models.json 里是否有该 id 的登记条目(文案与诊断用)。 */
    readonly known: boolean;
}
/** 能力索引:按模型 id 查询,内部缓存 models.json 的解析结果。 */
export interface ModelCapabilityIndex {
    /** 查询一个模型 id 的图片能力(绝不抛错)。 */
    capabilityOf(modelId: string): ModelImageCapability;
    /** 当前生效的 models.json 路径(诊断用)。 */
    path(): string;
    /** 丢弃缓存(设置变更/测试用)。 */
    invalidate(): void;
}
/**
 * CodeBuddy 的配置目录:环境变量 `CODEBUDDY_CONFIG_DIR`(与 CLI 自身口径一致)
 * 优先,否则 `~/.codebuddy`。
 * @returns 配置目录绝对路径。
 */
export declare function resolveCodebuddyConfigDir(): string;
/**
 * 当前生效的 models.json 路径。
 * @param configDir - 显式配置目录(设置覆写用);缺省走 {@link resolveCodebuddyConfigDir}。
 * @returns models.json 绝对路径。
 */
export declare function resolveCodebuddyModelsPath(configDir?: string): string;
/**
 * 解析 models.json 文本 → id → supportsImages。
 *
 * 防御式:非法 JSON、`models` 非数组、条目缺 id 一律跳过;`supportsImages`
 * **只有字面 `true` 算支持**,缺失/异常类型按 false(登记了但不支持图片)。
 * @param text - models.json 文件内容。
 * @returns id → 是否支持图片;任何异常都返回空表。
 */
export declare function parseModelsJson(text: string): Map<string, boolean>;
/**
 * 按 id 回查图片能力:原样 id → 剥 `custom-local:` → 剥 `custom:`。
 * @param table - {@link parseModelsJson} 的解析结果。
 * @param modelId - CLI 路由上的模型 id(可能带别名前缀)。
 * @returns 能力;任何一级都没命中时 `{supportsImages:false, known:false}`。
 */
export declare function lookupSupportsImages(table: ReadonlyMap<string, boolean>, modelId: string): ModelImageCapability;
/** {@link createModelCapabilityIndex} 的选项。 */
export interface ModelCapabilityIndexOptions {
    /** models.json 路径(每次调用求值,支持设置热改);默认 {@link resolveCodebuddyModelsPath}。 */
    modelsPath?: () => string;
    /** 注入时钟(测试用),默认 `Date.now`。 */
    now?: () => number;
}
/**
 * 创建能力索引:缓存策略 = **mtime+size 失效**(改文件下一次调用即生效)
 * + 1s 去抖 + 30s 强制重读 + 失败缓存 60s;任何失败都退化为空表(全按仅文本)。
 * @param options - 路径来源与时钟(测试注入)。
 * @returns 能力索引。
 */
export declare function createModelCapabilityIndex(options?: ModelCapabilityIndexOptions): ModelCapabilityIndex;
