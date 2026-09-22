/**
 * steer(插话投递)诊断日志。
 *
 * 为什么单独一个模块:写日志的两侧是 `adapter`(空跑收尾)与 `pump`(轮询/投递),
 * 而 pump **不能** import adapter(注释里写明"避免与 adapter.ts 形成运行时循环"),
 * 所以共用实现必须落在两者之外。
 *
 * 为什么值得留:2026-09-22 用户报障「插队消息收不到」时,dsh 侧的事件完全正常
 * (消息被 claim 进 step 输入),CLI 侧却一个字都没收到 —— 而 pump 的轮询/投递
 * 决策**没有任何落盘痕迹**,只能靠读源码猜。这一条日志通道就是为了让下次一眼
 * 定位:轮询是否停摆(哪个守卫)、扫描是否看到消息、steer 是否被拒。
 * @param line - 一行诊断(自带时间戳)。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function steerDebug(line) {
    try {
        mkdirSync(join(homedir(), '.dsh', 'codebuddy'), { recursive: true });
        appendFileSync(join(homedir(), '.dsh', 'codebuddy', 'steer-debug.log'), `${new Date().toISOString()} ${line}\n`);
    }
    catch { /* 诊断不影响主流程 */ }
}
