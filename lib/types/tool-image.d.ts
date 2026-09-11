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
 * 块,并附**与原生 `formatImageReadOutput` 逐字同形**的信封文本(UI 的图片
 * 卡片用正则按形状识别该信封,缺 `<path>` 行会整体回退通用卡)。任何未知块/
 * 解析失败/入库失败都整体回退(undefined),避免半转换。
 * @param attachments - dsh attachments 服务面(缺失则放弃转换)。
 * @param text - 工具输出原文。
 * @param path - 目标文件路径(别名 read_image 的 meta 路径;缺失时信封退化为
 *   无 path 形态,图片卡片会因 meta 缺失自动回退,不影响内容正确性)。
 * @returns 内容块数组,或 undefined(保持原文路径)。
 */
export declare function toolResultBlocksFromText(attachments: AttachmentsSaveFace | undefined, text: string, path?: string): Promise<Array<Record<string, unknown>> | undefined>;
/**
 * 图片文件的 Read → dsh 原生 `read_image` 别名。
 *
 * UI 的图片卡片模型硬判定 `call?.name === 'read_image'`,且根调用还要
 * tool/result 携带 `meta.path`(与原生 read_image 的 presentationMeta 同形)。
 * 只有"读到图片文件"的 Read 才改名,其余调用保持原名原样;广告与
 * tool/call 的名字由我们同一处写出,严格校验的逐字一致不受影响。
 * @param name - CodeBuddy 工具名(如 Read)。
 * @param argsJson - 调用参数(对象或 JSON 字符串)。
 * @returns 别名与 meta 路径,或 undefined(保持原名)。
 */
export declare function imageReadAlias(name: string, argsJson: unknown): {
    name: 'read_image';
    path: string;
} | undefined;
