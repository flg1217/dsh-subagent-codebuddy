/**
 * dsh 消息 → CodeBuddy 原生会话记录(JSONL)转换器。
 *
 * 已有对话切换到 codebuddy 时,把折叠后的 dsh 历史写成 CodeBuddy 的
 * 项目会话文件(`~/.codebuddy/projects/<slug>/<sessionId>.jsonl`),再以
 * `session/load` 载入——历史以**原生消息**(user/assistant/工具调用)进入
 * CodeBuddy 会话,而不是压成一段提示词文本(实测:合成文件被接受,模型
 * 能正确引用其中内容)。
 *
 * 记录形态(取自真实会话文件):
 * - `message`: {id, timestamp, type:'message', role, content:[input_text|output_text]}
 * - `function_call`: {id, parentId, timestamp, type, callId, name, arguments}
 * - `function_call_result`: {id, parentId, timestamp, type, name, callId, status, output}
 * - id 为 UUIDv7(时间序);parentId 串链到前一条记录。
 * @module subagent-codebuddy/native-session
 */
import type { Message } from '@deepseek-ai/dsh-llm';
/** 一条 CodeBuddy 原生记录(宽松结构,字段与 CLI 写出的一致)。 */
export type NativeRecord = Record<string, unknown> & {
    type: string;
    id: string;
};
/** 转换上下文。 */
export interface NativeSessionContext {
    /** CodeBuddy 会话 id(同时是文件名)。 */
    sessionId: string;
    /** 工作目录(记录内 cwd 与项目 slug 的来源)。 */
    cwd: string;
}
/** 图片面:dsh attachment 引用 → 字节(写入 CodeBuddy blob)。 */
export interface NativeSessionImages {
    readImage: (ref: unknown) => Promise<{
        data: Uint8Array;
        ref?: {
            mediaType?: string;
        };
    }>;
    /** blob 根目录(测试注入;默认 `~/.codebuddy/blobs`)。 */
    blobsRoot?: string;
}
/** UUIDv7(时间序),与 CodeBuddy 记录 id 同构。 */
export declare function uuidv7(): string;
/** cwd → CodeBuddy 项目目录 slug(如 `H:\Projects\x` → `h-Projects-x`)。 */
export declare function projectSlug(cwd: string): string;
/** 会话文件路径;baseDir 默认 `~/.codebuddy/projects`(测试可注入)。 */
export declare function conversationFilePath(sessionId: string, cwd: string, baseDir?: string): string;
/**
 * 把 dsh 消息序列转换为 CodeBuddy 原生记录。
 *
 * 映射:user → `message(input_text)`;assistant 文本 → `message(output_text)`;
 * assistant 的 tool-call 块 → `function_call`;tool 结果消息 → `function_call_result`;
 * reasoning 块跳过。user 消息的图片块写出 blob(内容寻址)后以原生
 * `image_blob_ref` 内容块进入记录;parentId 串链到前一条记录。
 * @param messages - 折叠视图的消息序列(压缩后的原始历史不会在这里出现)。
 * @param context - 会话 id 与工作目录。
 * @param images - 图片读取面(缺省时图片退化为 `[图片]` 文本占位)。
 * @returns 记录数组(按时间顺序,可直接写 JSONL)。
 */
export declare function messagesToRecords(messages: readonly Message[], context: NativeSessionContext, images?: NativeSessionImages): Promise<NativeRecord[]>;
/** 会话文件的头部记录(CLI 自己也会写,合成时补一份保证结构完整)。 */
export declare function sessionMetaRecords(context: NativeSessionContext): NativeRecord[];
/** 写入(覆盖)会话文件;原子写(tmp + rename)。 */
export declare function writeConversationFile(file: string, records: readonly NativeRecord[], context: NativeSessionContext): void;
/** 追加记录到已有会话文件(缺失轮次补写)。 */
export declare function appendConversationRecords(file: string, records: readonly NativeRecord[]): void;
