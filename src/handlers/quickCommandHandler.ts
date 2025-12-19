import { Durable } from "../index";
import { CommandResult } from "../utils/shard.d";

/**
 * 快捷命令处理器
 * 统一处理 /pre、表情包等特殊消息
 * 设计原则：高扩展性，便于添加新命令
 */

// 命令处理函数类型
type CommandHandler = (
  content: string,
  uid: string,
  env: Env,
  durable: DurableObjectStub<Durable>
) => Promise<CommandResult>;

// 命令注册表
interface CommandRegistry {
  pattern: RegExp | string;
  name: string;
  description: string;
  handler: CommandHandler;
}

const commands: CommandRegistry[] = [];

/**
 * 注册新命令
 */
export function registerCommand(
  pattern: RegExp | string,
  name: string,
  description: string,
  handler: CommandHandler
): void {
  commands.push({ pattern, name, description, handler });
}

/**
 * 处理命令
 * @returns CommandResult，如果 handled=true 表示已处理，不走 LLM
 */
export async function handleCommand(
  content: string,
  uid: string,
  env: Env,
  durable: DurableObjectStub<Durable>
): Promise<CommandResult> {
  // 空内容或不支持的消息
  if (!content) {
    return {
      handled: true,
      content: "[我读的书少] 能不能说点我听得懂的",
      shouldLog: false
    };
  }

  // 不支持的消息类型
  if (content === "[收到不支持的消息类型，暂无法显示]") {
    return {
      handled: true,
      content: "[我读的书少] 能不能说点我听得懂的",
      shouldLog: false
    };
  }

  // 遍历所有注册的命令
  for (const cmd of commands) {
    let matched = false;
    if (typeof cmd.pattern === "string") {
      matched = content === cmd.pattern;
    } else {
      matched = cmd.pattern.test(content);
    }

    if (matched) {
      try {
        return await cmd.handler(content, uid, env, durable);
      } catch (e: any) {
        console.error(`Command ${cmd.name} error:`, e);
        return {
          handled: true,
          content: `命令执行失败：${e.message}`,
          shouldLog: true,
          extra: { error: e.message, command: cmd.name }
        };
      }
    }
  }

  // 未匹配任何命令，返回 handled=false 走 LLM 处理
  return { handled: false };
}

/**
 * 获取所有已注册命令的列表（用于帮助信息）
 */
export function getCommandList(): { name: string; description: string }[] {
  return commands.map(cmd => ({
    name: cmd.name,
    description: cmd.description
  }));
}

// ============== 内置命令 ==============

// /pre 或 LLMLastMsg - 获取上一条AI回复
registerCommand(
  /^\/pre$/i,
  "获取上一条回复",
  "发送 /pre 获取上一条未能及时显示的AI回复",
  async (content, uid, env, durable) => {
    const lastContent = await durable.handleGetLastChatContent(uid);
    return {
      handled: true,
      content: lastContent,
      shouldLog: true,
      extra: { type: "get_last" }
    };
  }
);

// /new - 清空对话历史
registerCommand(
  /^\/new$/i,
  "新建对话",
  "发送 /new 清空对话历史，开始新对话",
  async (content, uid, env, durable) => {
    const result = await durable.handleClearChatHistory(uid);
    return {
      handled: true,
      content: result,
      shouldLog: true,
      extra: { type: "clear_history" }
    };
  }
);

// /help - 显示帮助
registerCommand(
  /^\/help$/i,
  "帮助",
  "发送 /help 显示可用命令列表",
  async (content, uid, env, durable) => {
    const cmdList = getCommandList();
    let helpText = "📚 可用命令列表：\n\n";
    for (const cmd of cmdList) {
      helpText += `▸ ${cmd.name}\n  ${cmd.description}\n\n`;
    }
    return {
      handled: true,
      content: helpText.trim(),
      shouldLog: false
    };
  }
);

// /status - 显示状态（可扩展）
registerCommand(
  /^\/status$/i,
  "状态查询",
  "发送 /status 查看当前状态",
  async (content, uid, env, durable) => {
    const userDetail = await durable.handleUserDetail(uid);
    if (!userDetail) {
      return {
        handled: true,
        content: "📊 暂无您的使用记录",
        shouldLog: false
      };
    }

    const statusText = `📊 您的使用状态：
▸ 消息数量：${userDetail.msgCount}
▸ LLM Token 消耗：${userDetail.llmTokens}
▸ 认证次数：${userDetail.authCount}
▸ 首次使用：${new Date(userDetail.firstSeen).toLocaleString("zh-CN")}
▸ 最后活跃：${new Date(userDetail.lastSeen).toLocaleString("zh-CN")}`;

    return {
      handled: true,
      content: statusText,
      shouldLog: false
    };
  }
);

/**
 * 动态注册 LLMLastMsg 命令（需要 env 参数）
 * 在应用启动时调用
 */
export function registerEnvCommands(env: Env): void {
  // 检查是否已注册
  const exists = commands.some(cmd => 
    typeof cmd.pattern === "string" && cmd.pattern === env.LLMLastMsg
  );
  
  if (!exists && env.LLMLastMsg && env.LLMLastMsg !== "/pre") {
    registerCommand(
      env.LLMLastMsg,
      "获取上一条回复(别名)",
      `发送 ${env.LLMLastMsg} 获取上一条未能及时显示的AI回复`,
      async (content, uid, env, durable) => {
        const lastContent = await durable.handleGetLastChatContent(uid);
        return {
          handled: true,
          content: lastContent,
          shouldLog: true,
          extra: { type: "get_last_alias" }
        };
      }
    );
  }
}
