/**
 * CodeBuddy 图片读取的工具输出转换。
 *
 * CLI 把 Read 等工具读到的图片以**文本 JSON** 交付:
 *   [{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]
 * 原样落库会让 dsh UI 显示整屏 base64(还常被长度截断)。本模块识别该形态 →
 * 经 dsh attachments 服务 `saveImage` 落成 durable 引用 → 产出**与原生
 * read_image 工具一致**的内容块(描述文本 + image 块),UI 按图片渲染。
 * 识别失败/服务缺失时返回 undefined,调用方保持原文本。
 * @module subagent-codebuddy/tool-image
 */
/** dsh `ctx.attachments` 的最小面(与原生 read_image 同法的单图入库)。 */
export interface AttachmentsSaveFace {
    saveImage(input: {
        data: Uint8Array;
        mediaType: string;
        name?: string;
    }): Promise<unknown>;
}
/** `data:image/<subtype>;base64,<payload>` → 媒体类型与 base64 载荷。 */
export declare function parseImageDataUrl(url: string): {
    mediaType: string;
    data: string;
} | undefined;
/**
 * 工具输出文本 → dsh 内容块(仅在确为"含图片块的 JSON 数组"时转换)。
 *
 * 支持混排:文本块原样保留;`image_url` 块解码后 `saveImage` 入库,转 image
 * 块,并附描述信封文本。任何未知块/解析失败/入库失败都整体回退(undefined),
 * 避免半转换。
 *
 * **信封为什么不再带 `<path>`(2026-09-18,与"内置工具全禁"同一批):** UI 的
 * 图片卡片有两道硬门槛——`IMAGE_ENVELOPE` 正则要求首行 `<path>…</path>` 且根
 * 调用要有 `meta.path`,卡片模型还要求 `call.name === 'read_image'`。旧实现靠
 * `imageReadAlias` 把 CLI 的 Read 改名为 `read_image` 才凑齐三条;而那个改名会
 * 在 agent scope 里注册同名工具、**遮蔽 dsh 原生 `read_image`**(本插件最难受
 * 的偶发故障来源),已整体删除。别名既去,改名不再可能,补 `<path>` 也换不回
 * 卡片(名字那关照样不过)——所以信封保持无 path 形态。
 *
 * 影响面仅限**重放旧转录**:调用点只有两处——pump 的 `awaitResult` 与 mirror 的
 * `function_call_result`,两者都只在 CLI 以文本 JSON 交付图片结果时命中(新会话
 * 在内置工具全禁后不可能再产生)。重放时图片仍是正规 image 块(内容、落库、模型
 * 可见性都不变),只是 UI 从图片卡退回通用行(会把 image 块 `JSON.stringify`
 * 出来)。要恢复卡片只能把别名请回来,代价是重新引入工具遮蔽——不划算。
 * @param attachments - dsh attachments 服务面(缺失则放弃转换)。
 * @param text - 工具输出原文。
 * @returns 内容块数组,或 undefined(保持原文路径)。
 */
export declare function toolResultBlocksFromText(attachments: AttachmentsSaveFace | undefined, text: string): Promise<Array<Record<string, unknown>> | undefined>;
