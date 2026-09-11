/**
 * CodeBuddy CLI(Tencent)作为 dsh 的 LLM 提供方(模型供应商模式)。
 *
 * 结构对齐 dsh-llm-agy:
 *  1. 注册 `codebuddy` LLM provider 路由(CodebuddyLlmAdapter,ACP 协议)——
 *     主代理可直接在模型选择器里选用 CodeBuddy 模型(该轮由 CodeBuddy
 *     CLI 全权驱动,用它自己的工具链;dsh 的沙箱/审批不参与);同时
 *     通用 `subagent` 工具可通过 subagent-model-selection 委派
 *     `{provider: codebuddy, model: <id>}` 的进程内子代理。
 *  2. 可选注册自定义委派工具 `subagent_codebuddy` 与 `list_codebuddy_models`
 *     ——工具描述里内置"完整上下文"指引,作为通用工具之外的 opt-in 路径。
 *     开关在**设置面板**(设置 → 插件 → CodeBuddy,`registerSubagentTools`,
 *     默认关闭)实时生效,也可用插件行配置兜底。
 *
 * 模型目录:adapter `listModels()` 解析 `codebuddy --help` 的支持列表,
 * 供主模型选择器与 list_subagent_models 使用(带缓存,永不抛错)。
 * @module subagent-codebuddy
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "subagent-codebuddy";
export declare const inject: string[];
export interface Config {
    /** 可执行文件,默认 `codebuddy`。 */
    command?: string;
    /** 默认 CodeBuddy 模型 ID,默认 `deepseek-v4-flash`。 */
    model?: string;
    /**
     * 传给 `--permission-mode` 的权限模式,默认 `bypassPermissions`
     * (CodeBuddy 工具调用自动放行,不询问)。
     */
    permissionMode?: string;
    /** 追加的额外 CodeBuddy 参数。 */
    extraArgs?: string[];
    /** LLM provider 路由名,默认 `codebuddy`。 */
    providerName?: string;
    /** opt-in 工具名,默认 `subagent_codebuddy`。 */
    toolName?: string;
    /** 是否注册 opt-in 委派工具(默认关闭;设置面板同名开关优先)。 */
    registerSubagentTools?: boolean;
    /**
     * 静默长工具硬顶(分钟,默认 30;0 = 关闭硬顶)。
     * 只影响「发起后零事件」的工具段——任何中间进展(文本/思考/工具 update)
     * 都会重置计时,会冒泡的长工具不受影响。超顶时中止本次 CodeBuddy 调用
     * 并**自动续跑**(stall 重试);被误杀的工具通常工作已落盘,重跑代价可控。
     * 设为 0 则永不因静默中止(接受 CLI 卡死时进程泄漏、子会话回合悬空的风险)。
     */
    longToolCapMinutes?: number;
    /**
     * 尾巴窗口静默阈值(秒,默认 5;0 = 关闭)。
     *
     * CodeBuddy 的 `end_turn` 不等于空闲:后台任务(后台 bash / agent 任务)完成时
     * CLI 会**自发续跑**,续跑内容以普通流式事件推过来。若回合在 `end_turn` 处
     * 直接收尾,插件就不再抽流,这些内容全丢——用户永远等不到模型承诺的
     * "跑完我继续/给你最终结果"。尾巴窗口:干净收尾后继续抽流,直到 CLI 报
     * `idle` 且静默达到本阈值(普通回合的额外延迟就是这个值)、或 CLI 广播
     * `session_end`(真正空闲,立即收尾)、或撞上 {@link tailCapMinutes}。
     */
    tailQuietSeconds?: number;
    /**
     * 起了后台任务的回合的静默阈值(分钟,默认 10)。
     *
     * 后台任务在跑时 CLI 可以长时间零事件;识别到本轮起过后台任务
     * (工具参数 `run_in_background`/`background`)后,尾巴窗口放宽到本阈值,
     * 等它跑完的自发续跑;续跑内容一出现即回到 tailQuietSeconds。
     */
    tailBgQuietMinutes?: number;
    /** 尾巴窗口硬顶(分钟,默认 30):后台任务最长可拖着回合不闭合的时长。 */
    tailCapMinutes?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
