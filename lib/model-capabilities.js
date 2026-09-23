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
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** 模型 id 的别名前缀:CLI 用它们引用自定义模型(`custom-local:<id>` / `custom:<id>`)。 */
export const CUSTOM_LOCAL_PREFIX = 'custom-local:';
/** 另一条自定义模型前缀(见 CLI 产物的 `CUSTOM_MODEL_ID_PREFIX`)。 */
export const CUSTOM_PREFIX = 'custom:';
/** 空表:读不到 models.json 时的解析结果。 */
const EMPTY_TABLE = new Map();
/** 同一请求内的去抖窗口:避免选择器/闸门/目录的高频调用反复 stat。 */
const DEBOUNCE_MS = 1_000;
/** 强制重读上限:mtime 不可靠的文件系统上,最长陈旧这么久。 */
const FORCE_RELOAD_MS = 30_000;
/** 读取/解析失败后的缓存窗口:文件缺失是常态,不反复重试。 */
const FAILURE_TTL_MS = 60_000;
/**
 * CodeBuddy 的配置目录:环境变量 `CODEBUDDY_CONFIG_DIR`(与 CLI 自身口径一致)
 * 优先,否则 `~/.codebuddy`。
 * @returns 配置目录绝对路径。
 */
export function resolveCodebuddyConfigDir() {
    const fromEnv = process.env.CODEBUDDY_CONFIG_DIR?.trim();
    if (fromEnv !== undefined && fromEnv.length > 0)
        return fromEnv;
    return join(homedir(), '.codebuddy');
}
/**
 * 当前生效的 models.json 路径。
 * @param configDir - 显式配置目录(设置覆写用);缺省走 {@link resolveCodebuddyConfigDir}。
 * @returns models.json 绝对路径。
 */
export function resolveCodebuddyModelsPath(configDir) {
    const dir = configDir !== undefined && configDir.trim().length > 0 ? configDir.trim() : resolveCodebuddyConfigDir();
    return join(dir, 'models.json');
}
/**
 * 解析 models.json 文本 → id → supportsImages。
 *
 * 防御式:非法 JSON、`models` 非数组、条目缺 id 一律跳过;`supportsImages`
 * **只有字面 `true` 算支持**,缺失/异常类型按 false(登记了但不支持图片)。
 * @param text - models.json 文件内容。
 * @returns id → 是否支持图片;任何异常都返回空表。
 */
export function parseModelsJson(text) {
    const table = new Map();
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return table;
    }
    const models = parsed?.models;
    if (!Array.isArray(models))
        return table;
    for (const entry of models) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
            continue;
        const { id, supportsImages } = entry;
        if (typeof id !== 'string' || id.trim().length === 0)
            continue;
        table.set(id.trim(), supportsImages === true);
    }
    return table;
}
/**
 * 按 id 回查图片能力:原样 id → 剥 `custom-local:` → 剥 `custom:`。
 * @param table - {@link parseModelsJson} 的解析结果。
 * @param modelId - CLI 路由上的模型 id(可能带别名前缀)。
 * @returns 能力;任何一级都没命中时 `{supportsImages:false, known:false}`。
 */
export function lookupSupportsImages(table, modelId) {
    const trimmed = modelId.trim();
    if (trimmed.length === 0)
        return { supportsImages: false, known: false };
    const candidates = [trimmed];
    for (const prefix of [CUSTOM_LOCAL_PREFIX, CUSTOM_PREFIX]) {
        if (trimmed.startsWith(prefix))
            candidates.push(trimmed.slice(prefix.length));
    }
    for (const candidate of candidates) {
        const value = table.get(candidate);
        if (value !== undefined)
            return { supportsImages: value, known: true };
    }
    return { supportsImages: false, known: false };
}
/**
 * 创建能力索引:缓存策略 = **mtime+size 失效**(改文件下一次调用即生效)
 * + 1s 去抖 + 30s 强制重读 + 失败缓存 60s;任何失败都退化为空表(全按仅文本)。
 * @param options - 路径来源与时钟(测试注入)。
 * @returns 能力索引。
 */
export function createModelCapabilityIndex(options = {}) {
    const now = options.now ?? (() => Date.now());
    const modelsPath = options.modelsPath ?? (() => resolveCodebuddyModelsPath());
    let loaded;
    let failedAt;
    /** 读表(带缓存);任何异常都返回空表。 */
    const load = () => {
        const at = now();
        const path = modelsPath();
        if (loaded !== undefined && loaded.path === path && at - loaded.checkedAt < DEBOUNCE_MS) {
            return loaded.table;
        }
        if (failedAt !== undefined && at - failedAt < FAILURE_TTL_MS)
            return EMPTY_TABLE;
        let mtimeMs;
        let size;
        try {
            const stat = statSync(path);
            mtimeMs = stat.mtimeMs;
            size = stat.size;
        }
        catch {
            loaded = undefined;
            failedAt = at;
            return EMPTY_TABLE;
        }
        if (loaded !== undefined && loaded.path === path
            && loaded.mtimeMs === mtimeMs && loaded.size === size
            && at - loaded.loadedAt < FORCE_RELOAD_MS) {
            loaded.checkedAt = at;
            return loaded.table;
        }
        try {
            const table = parseModelsJson(readFileSync(path, 'utf8'));
            loaded = { path, mtimeMs, size, loadedAt: at, checkedAt: at, table };
            failedAt = undefined;
            return table;
        }
        catch {
            loaded = undefined;
            failedAt = at;
            return EMPTY_TABLE;
        }
    };
    return {
        capabilityOf(modelId) {
            return lookupSupportsImages(load(), modelId);
        },
        path() {
            return modelsPath();
        },
        invalidate() {
            loaded = undefined;
            failedAt = undefined;
        },
    };
}
